using DV.Signs;
using Newtonsoft.Json.Linq;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Threading.Tasks;
using UnityEngine;

namespace DvMod.RemoteDispatch_BT
{
    /// <summary>
    /// Builds a world-wide baseline using the game's SignPlacer without placing any
    /// objects. Loaded scenery can contain additional authored poles; accumulate
    /// those as the world streams in rather than limiting the map to the player area.
    /// </summary>
    public static class RailSigns
    {
        private const int Version = 4;
        private const float SceneScanInterval = 15f;
        private const float GeneratedMatchRadius = 4f; // baked poles sit beside the centerline
        private const float LoadedMatchRadius = 0.35f; // tolerate drift after an origin shift
        private const float MatchHeadingTolerance = 15f;
        private const BindingFlags InstanceMember = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        // All reads and updates to the world cache take place on the game thread.
        private static List<Pole>? cachedPoles;
        private static string? signsJson;
        private static float nextSceneScan;
        private static int generatedCount;
        private static long computeMs;
        private static string? generationWarning;

        private static readonly Dictionary<(Type, string), MethodInfo?> methods =
            new Dictionary<(Type, string), MethodInfo?>();
        private static readonly FieldInfo? parameterField = typeof(Sign).GetField("signParameters", InstanceMember);

        private struct SpeedFace
        {
            public int kmh;
            public string? arrow;
            public string? speedChange;
        }

        private struct GradeFace
        {
            public string kind;
            public string text;
            public double? percent;
        }

        private sealed class Pole
        {
            public readonly Vector2 position;
            public readonly float heading;
            public readonly string key;
            public readonly JObject json;

            public Pole(Vector2 position, float heading, string key, JObject json)
            {
                this.position = position;
                this.heading = heading;
                this.key = key;
                this.json = json;
            }
        }

        public static void ResetCache()
        {
            cachedPoles = null;
            signsJson = null;
            nextSceneScan = 0;
            generatedCount = 0;
            computeMs = 0;
            generationWarning = null;
        }

        public static Task<string> GetSignsJSON() => Updater.RunOnMainThread(GetOrRefreshSigns);

        private static string GetOrRefreshSigns()
        {
            if (!WorldStreamingInit.Instance || !WorldStreamingInit.IsLoaded || RailTrackRegistry.Instance == null)
                return new JObject
                {
                    ["version"] = Version,
                    ["ready"] = false,
                    ["speedPoles"] = 0,
                    ["gradePoles"] = 0,
                    ["poles"] = new JArray(),
                }.ToString(Newtonsoft.Json.Formatting.None);

            if (cachedPoles == null)
            {
                var stopwatch = System.Diagnostics.Stopwatch.StartNew();
                cachedPoles = new List<Pole>();
                generationWarning = GenerateNetworkPoles(cachedPoles, WorldMover.currentMove);
                generatedCount = cachedPoles.Count;
                computeMs = stopwatch.ElapsedMilliseconds;
            }

            var now = Time.realtimeSinceStartup;
            if (signsJson != null && now < nextSceneScan)
                return signsJson;
            nextSceneScan = now + SceneScanInterval;

            var before = cachedPoles.Count;
            ReadLoadedPoles(cachedPoles, WorldMover.currentMove, out var sceneSigns, out var sceneMatched);
            if (signsJson == null || before != cachedPoles.Count)
                signsJson = SerializeSigns(cachedPoles, sceneSigns, sceneMatched);
            return signsJson;
        }

        private static string SerializeSigns(List<Pole> poles, int sceneSigns, int sceneMatched)
        {
            int speedPoles = 0, gradePoles = 0;
            var entries = new JArray();
            foreach (var pole in poles)
            {
                if (pole.json.ContainsKey("speeds")) speedPoles++;
                if (pole.json.ContainsKey("grade")) gradePoles++;
                entries.Add(pole.json.DeepClone()); // keep cached poles detached from old snapshots
            }

            var result = new JObject
            {
                ["version"] = Version,
                ["ready"] = true,
                ["generatedAt"] = DateTime.UtcNow.ToString("o"),
                ["computeMs"] = computeMs,
                ["generatedPoles"] = generatedCount,
                ["speedPoles"] = speedPoles,
                ["gradePoles"] = gradePoles,
                ["sceneSigns"] = sceneSigns,
                ["sceneMatched"] = sceneMatched,
                ["sceneAddedPoles"] = poles.Count - generatedCount,
                ["poles"] = entries,
            };
            if (generationWarning != null)
                result["generationWarning"] = generationWarning;
            return result.ToString(Newtonsoft.Json.Formatting.None);
        }

        private static string? GenerateNetworkPoles(List<Pole> poles, Vector3 move)
        {
            var placerObject = new GameObject("[RemoteDispatch sign computation]");
            // SignPlacer.Start() would create real scene objects, so keep this inactive.
            placerObject.SetActive(false);
            try
            {
                var placer = placerObject.AddComponent<SignPlacer>();
                CopyPlacerSettings(placer);
                var trackMethod = typeof(SignPlacer).GetMethod("GetTrackSigns", InstanceMember, null,
                    new[] { typeof(RailTrack), typeof(bool) }, null);
                var junctionMethod = typeof(SignPlacer).GetMethod("GetJunctionSigns", InstanceMember, null,
                    new[] { typeof(Junction) }, null);
                var warnings = new List<string>();
                if (parameterField == null)
                    return "The game's generated sign parameters are unavailable; showing loaded poles only.";

                int failed = 0;
                if (placer.placeTrackSigns && trackMethod != null)
                {
                    // Generate each direction independently so a malformed track cannot
                    // discard every other sign already generated in the world.
                    foreach (var track in RailTrackRegistry.Instance.AllTracks)
                    {
                        if (!IsSignTrack(track) || !track.CurveIsValid() || ExcludedByPlacer(track, placer))
                            continue;
                        if (!ReadGeneratedPoles(placer, trackMethod, new object[] { track, false }, move, null, poles)) failed++;
                        if (!ReadGeneratedPoles(placer, trackMethod, new object[] { track, true }, move, null, poles)) failed++;
                    }
                }
                else if (placer.placeTrackSigns)
                {
                    warnings.Add("Track sign generation is unavailable.");
                }

                if (placer.placeJunctionSigns && junctionMethod != null)
                {
                    foreach (var junction in RailTrackRegistry.Instance.OrderedJunctions)
                    {
                        if (junction == null || junction.inBranch == null || junction.inBranch.track == null ||
                            junction.outBranches == null || junction.outBranches.Count != 2 ||
                            ExcludedByPlacer(junction.inBranch.track, placer))
                            continue;
                        if (!ReadGeneratedPoles(placer, junctionMethod, new object[] { junction }, move, junction, poles)) failed++;
                    }
                }
                else if (placer.placeJunctionSigns)
                {
                    warnings.Add("Junction sign generation is unavailable.");
                }
                if (failed > 0)
                    warnings.Add($"{failed} track directions or junctions could not be read.");
                return warnings.Count > 0 ? string.Join(" ", warnings) : null;
            }
            catch (Exception e)
            {
                Main.DebugLog(() => $"Network sign generation failed: {e}");
                return "Network sign generation is incomplete; loaded poles are still included.";
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(placerObject);
            }
        }

        private static bool ReadGeneratedPoles(SignPlacer placer, MethodInfo method, object[] args,
            Vector3 move, Junction? junction, List<Pole> poles)
        {
            bool ok = true;
            try
            {
                if (!(method.Invoke(placer, args) is IEnumerable generated))
                    return false;
                foreach (var signData in generated)
                {
                    if (signData == null)
                        continue;
                    try
                    {
                        var type = signData.GetType();
                        var sign = Method(type, "GetSign")?.Invoke(signData, null);
                        if (sign == null || !(parameterField?.GetValue(sign) is IEnumerable<SignParameters> parameters) ||
                            !(Method(type, "GetPosition")?.Invoke(signData, null) is Vector3 position) ||
                            !(Method(type, "GetRotation")?.Invoke(signData, null) is Quaternion rotation))
                        {
                            ok = false;
                            continue;
                        }
                        var track = Method(type, "GetTrack")?.Invoke(signData, null) as RailTrack;
                        // GetTrackSigns was called for this real track; never infer a track by proximity.
                        if (track == null && junction == null && args.Length > 0)
                            track = args[0] as RailTrack;
                        var pole = MakePole(parameters, position - move, -(rotation * Vector3.forward), junction, track);
                        if (pole != null)
                            poles.Add(pole);
                    }
                    catch (Exception e)
                    {
                        ok = false;
                        Main.DebugLog(() => $"Failed to read generated sign: {e.GetType().Name}");
                    }
                }
            }
            catch (Exception e)
            {
                Main.DebugLog(() => $"Failed to generate signs: {(e.InnerException ?? e).Message}");
                return false;
            }
            return ok;
        }

        private static void CopyPlacerSettings(SignPlacer target)
        {
            // Do not apply settings of a single-track placer to the entire world.
            foreach (var source in UnityEngine.Object.FindObjectsOfType<SignPlacer>())
            {
                if (source == target || source.GetComponent<RailTrack>() != null || source.GetComponent<Junction>() != null)
                    continue;
                target.minArcLength = source.minArcLength;
                target.error = source.error;
                target.minimizeSpeedDiffThreshold = source.minimizeSpeedDiffThreshold;
                target.minimizeSpeedSegmentLengthThreshold = source.minimizeSpeedSegmentLengthThreshold;
                target.lastSegmentOptimalLength = source.lastSegmentOptimalLength;
                target.mergeSameSpeedSigns = source.mergeSameSpeedSigns;
                target.minimizeSpeedDifference = source.minimizeSpeedDifference;
                target.placeTrackSigns = source.placeTrackSigns;
                target.placeJunctionSigns = source.placeJunctionSigns;
                target.noSignsTrackNameMarks = source.noSignsTrackNameMarks;
                break;
            }
        }

        private static bool ExcludedByPlacer(RailTrack track, SignPlacer placer) =>
            placer.noSignsTrackNameMarks?.Exists(mark => mark != null && track.name.StartsWith(mark, StringComparison.Ordinal)) == true;

        private static bool IsSignTrack(RailTrack? track)
        {
            if (track == null || track.curve == null || track.curve.length < 100f)
                return false;
            // These are the same exclusions that the stock SignPlacer uses.
            return !track.name.StartsWith("[Y]", StringComparison.Ordinal) && !track.name.StartsWith("[#]", StringComparison.Ordinal);
        }

        private static void ReadLoadedPoles(List<Pole> poles, Vector3 move, out int sceneSigns, out int matched)
        {
            sceneSigns = 0;
            matched = 0;
            foreach (var generator in UnityEngine.Object.FindObjectsOfType<SignGeneratorData>())
            {
                if (generator == null || generator.signParameters == null)
                    continue;
                try
                {
                    var debug = generator.GetComponentInParent<SignDebug>();
                    var pose = debug != null ? debug.transform : generator.transform;
                    var pole = MakePole(generator.signParameters, pose.position - move, -pose.forward, null, null);
                    if (pole == null)
                        continue;
                    sceneSigns++;
                    if (HasMatchingPole(poles, pole))
                        matched++;
                    else
                        poles.Add(pole);
                }
                catch (Exception e)
                {
                    Main.DebugLog(() => $"Failed to read loaded sign: {e.GetType().Name}");
                }
            }
        }

        private static bool HasMatchingPole(List<Pole> poles, Pole incoming)
        {
            for (int i = 0; i < poles.Count; i++)
            {
                var other = poles[i];
                float radius = i < generatedCount ? GeneratedMatchRadius : LoadedMatchRadius;
                if ((incoming.position - other.position).sqrMagnitude <= radius * radius &&
                    Mathf.Abs(Mathf.DeltaAngle(incoming.heading, other.heading)) <= MatchHeadingTolerance &&
                    incoming.key == other.key)
                    return true;
            }
            return false;
        }

        private static Pole? MakePole(IEnumerable<SignParameters> parameters, Vector3 position,
            Vector3 travel, Junction? junction, RailTrack? track)
        {
            if (!IsFinite(position.x) || !IsFinite(position.z) || !IsFinite(travel.x) || !IsFinite(travel.z))
                return null;
            var (speeds, grades) = ReadParameters(parameters);
            if (speeds.Count == 0 && grades.Count == 0)
                return null;

            var heading = Heading(travel);
            var json = new JObject
            {
                ["p"] = new World.Position(position).ToLatLon().ToJson(),
                ["heading"] = heading,
            };
            // A known track ID is ordering metadata only. The original pole still
            // supplies p, including any offset from the rail centreline.
            if (track != null && junction == null)
            {
                try
                {
                    var trackId = RailTracks.TrackId(track);
                    if (!string.IsNullOrEmpty(trackId))
                        json["track"] = trackId;
                }
                catch (Exception)
                {
                    // Unidentified tracks remain valid independent poles.
                }
            }
            if (speeds.Count > 0)
            {
                var rows = new JArray();
                foreach (var face in speeds)
                {
                    float faceHeading = heading;
                    bool? main = track != null && junction == null ? IsSignTrack(track) : (bool?)null;
                    if (junction != null && face.arrow != null)
                    {
                        int i = face.arrow == "left" ? 0 : 1;
                        if (junction.outBranches.Count > i && junction.outBranches[i] is Junction.Branch branch && branch.track != null)
                        {
                            if (TryDepartingHeading(branch, out var branchHeading))
                                faceHeading = branchHeading;
                            var next = branch.first ? branch.track.outBranch : branch.track.inBranch;
                            main = IsSignTrack(next?.track ?? branch.track);
                        }
                    }
                    var row = new JObject { ["kmh"] = face.kmh, ["heading"] = faceHeading };
                    if (main.HasValue) row["main"] = main.Value;
                    if (face.arrow != null) row["arrow"] = face.arrow;
                    if (face.speedChange != null) row["speedChange"] = face.speedChange;
                    rows.Add(row);
                }
                json["speeds"] = rows;
            }
            if (grades.Count > 0)
            {
                var rows = new JArray();
                foreach (var face in grades)
                {
                    var row = new JObject { ["kind"] = face.kind, ["text"] = face.text, ["heading"] = heading };
                    if (face.percent.HasValue) row["percent"] = face.percent.Value;
                    if (track != null && junction == null) row["main"] = IsSignTrack(track);
                    rows.Add(row);
                }
                // Keep the original single-grade property for older clients.
                json["grade"] = rows[0].DeepClone();
                if (rows.Count > 1) json["grades"] = rows;
            }
            return new Pole(new Vector2(position.x, position.z), heading, PoleKey(speeds, grades), json);
        }

        private static (List<SpeedFace>, List<GradeFace>) ReadParameters(IEnumerable<SignParameters> parameters)
        {
            var speeds = new List<SpeedFace>();
            var grades = new List<GradeFace>();
            int speedIndex = -1;
            foreach (var parameter in parameters)
            {
                switch (parameter.type)
                {
                    case SignType.SpeedLimit:
                    case SignType.SpeedLimitOld:
                    case SignType.SpeedLimitYellow:
                    case SignType.SpeedLimitYellowOld:
                        speedIndex = -1;
                        if (TryParseSpeed(parameter.signText, out var kmh))
                        {
                            speedIndex = speeds.Count;
                            speeds.Add(new SpeedFace { kmh = kmh });
                        }
                        break;
                    case SignType.ArrowLeft:
                    case SignType.ArrowRight:
                        if (speedIndex >= 0)
                        {
                            var face = speeds[speedIndex];
                            face.arrow = parameter.type == SignType.ArrowLeft ? "left" : "right";
                            speeds[speedIndex] = face;
                        }
                        break;
                    case SignType.UpcomingSpeedUp:
                    case SignType.UpcomingSpeedUpOld:
                    case SignType.UpcomingSpeedDown:
                    case SignType.UpcomingSpeedDownOld:
                        if (speedIndex >= 0)
                        {
                            var face = speeds[speedIndex];
                            face.speedChange = parameter.type == SignType.UpcomingSpeedUp || parameter.type == SignType.UpcomingSpeedUpOld
                                ? "up" : "down";
                            speeds[speedIndex] = face;
                        }
                        break;
                    case SignType.GradeUp:
                    case SignType.GradeUpOld:
                    case SignType.GradeDown:
                    case SignType.GradeDownOld:
                    case SignType.GradeFlat:
                    case SignType.GradeFlatOld:
                        grades.Add(ReadGrade(parameter));
                        speedIndex = -1;
                        break;
                    default:
                        speedIndex = -1;
                        break;
                }
            }
            return (speeds, grades);
        }

        private static bool TryDepartingHeading(Junction.Branch branch, out float heading)
        {
            heading = 0;
            var track = branch.track;
            if (track == null || !track.CurveIsValid() || track.curve == null)
                return false;
            var tangent = track.curve.GetTangentAt(branch.first ? 0f : 1f);
            if (!branch.first)
                tangent = -tangent;
            tangent.y = 0f;
            if (!IsFinite(tangent.x) || !IsFinite(tangent.z) || tangent.sqrMagnitude < 1e-6f)
                return false;
            heading = Heading(tangent);
            return true;
        }

        private static GradeFace ReadGrade(SignParameters parameter)
        {
            var kind = parameter.type == SignType.GradeUp || parameter.type == SignType.GradeUpOld ? "up"
                : parameter.type == SignType.GradeDown || parameter.type == SignType.GradeDownOld ? "down"
                : "flat";
            var text = NormalizeNumberText(parameter.signText).TrimEnd('%').Trim();
            if (kind == "flat")
                return new GradeFace { kind = kind, text = "", percent = 0 };
            if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ||
                double.IsNaN(value) || double.IsInfinity(value))
                return new GradeFace { kind = kind, text = text };
            var percent = Math.Round(Math.Abs(value), 1);
            return new GradeFace
            {
                kind = kind,
                percent = percent,
                text = (kind == "down" ? "-" : "+") + percent.ToString("0.#", CultureInfo.InvariantCulture),
            };
        }

        private static string NormalizeNumberText(string? text) =>
            (text ?? string.Empty).Trim().Replace('\u2212', '-').Replace(',', '.');

        private static bool TryParseSpeed(string? text, out int kmh)
        {
            kmh = 0;
            // The original board omits the trailing zero: "5" means 50 km/h.
            if (!decimal.TryParse(NormalizeNumberText(text), NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var tens) ||
                tens <= 0 || tens > int.MaxValue / 10m)
                return false;
            var value = tens * 10m;
            if (decimal.Truncate(value) != value)
                return false;
            kmh = (int)value;
            return true;
        }

        private static bool IsFinite(float value) => !float.IsNaN(value) && !float.IsInfinity(value);

        private static float Heading(Vector3 direction) =>
            (float)Math.Round(Mathf.Repeat(Mathf.Atan2(direction.x, direction.z) * Mathf.Rad2Deg, 360f), 1);

        private static MethodInfo? Method(Type type, string name)
        {
            var key = (type, name);
            if (!methods.TryGetValue(key, out var method))
            {
                method = type.GetMethod(name, InstanceMember);
                methods[key] = method;
            }
            return method;
        }

        private static string PoleKey(List<SpeedFace> speeds, List<GradeFace> grades)
        {
            var speedKeys = speeds.ConvertAll(face =>
                face.kmh.ToString(CultureInfo.InvariantCulture) + ":" + face.arrow + ":" + face.speedChange);
            speedKeys.Sort(StringComparer.Ordinal);
            var gradeKeys = grades.ConvertAll(face => face.kind + ":" + face.text);
            gradeKeys.Sort(StringComparer.Ordinal);
            return string.Join(",", speedKeys) + "|" + string.Join(",", gradeKeys);
        }
    }
}
