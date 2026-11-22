using DV.PointSet;
using Newtonsoft.Json.Linq;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System;
using UnityEngine;

namespace DvMod.RemoteDispatch_BT
{
    public static class World
    {
        public readonly struct Position
        {
            public readonly float x;
            public readonly float z;

            public Position(float x, float z)
            {
                this.x = x;
                this.z = z;
            }

            public Position(Vector3 position) : this(position.x, position.z) { }
            public Position(Transform transform) : this(transform.position) { }

            public LatLon ToLatLon() => LatLon.From(this);
        }

        public readonly struct LatLon
        {
            private const int DECIMAL_PLACES = 8; // 1.11 mm
            private const float EARTH_CIRCUMFERENCE = 40e6f;
            private const float DEGREES_PER_METER = 360f / EARTH_CIRCUMFERENCE;

            public readonly float latitude;
            public readonly float longitude;

            public LatLon(float latitude, float longitude)
            {
                this.latitude = (float)Math.Round(latitude, DECIMAL_PLACES);
                this.longitude = (float)Math.Round(longitude, DECIMAL_PLACES);
            }

            public static LatLon From(Position p) => new LatLon(DEGREES_PER_METER * p.z, DEGREES_PER_METER * p.x);

            public JToken ToJson() => new JArray(latitude, longitude);
        }
    }

    public static class RailTracks
    {
        private const float MAX_SAMPLE_SPACING = 6f;
        private const float MIN_SAMPLE_SPACING = 0.05f;

        private static string? topologyJson;
        private static string? trackPointJson;
        private static string? junctionPointJson;

        public static void ResetCache()
        {
            topologyJson = null;
            trackPointJson = null;
            junctionPointJson = null;
        }

        internal static string TrackId(RailTrack track)
        {
            return track.LogicTrack().ID.FullDisplayID;
        }

        private static World.Position ToStablePosition(double x, double z)
        {
            var move = WorldMover.currentMove;
            return new World.Position((float)x - move.x, (float)z - move.z);
        }

        private static JArray SampleTrack(RailTrack track)
        {
            if (track == null || !track.CurveIsValid())
                return new JArray();

            EquiPointSet? points = null;
            try
            {
                var source = track.GetKinkedPointSet();
                if (source != null)
                {
                    var spacing = Mathf.Clamp((float)source.span / 3f, MIN_SAMPLE_SPACING, MAX_SAMPLE_SPACING);
                    points = track.GetUnkinkedPointSet(spacing);
                }
            }
            catch (Exception e)
            {
                Main.DebugLog(() => $"Failed to resample track {track.name}: {e.GetType().Name}");
            }
            try
            {
                points ??= track.GetKinkedPointSet();
            }
            catch (Exception e)
            {
                Main.DebugLog(() => $"Failed to sample track {track.name}: {e.GetType().Name}");
                return new JArray();
            }
            if (points == null)
                return new JArray();

            var array = new JArray();
            foreach (var point in points.points)
                array.Add(ToStablePosition(point.position.x, point.position.z).ToLatLon().ToJson());
            return array;
        }

        private static JObject? Port(Junction.Branch? branch, Dictionary<RailTrack, string> trackIds)
        {
            if (branch == null || branch.track == null || !trackIds.TryGetValue(branch.track, out var id))
                return null;
            return new JObject
            {
                ["track"] = id,
                ["end"] = branch.first ? "in" : "out",
            };
        }

        private static string PortKey(JObject port)
        {
            return port.Value<string>("track") + "\u0001" + port.Value<string>("end");
        }

        private static JObject GenerateTopology()
        {
            var tracks = UnityEngine.Object.FindObjectsOfType<RailTrack>();
            var trackIds = new Dictionary<RailTrack, string>();
            var coords = new JObject();

            foreach (var track in tracks)
            {
                if (track == null || !track.CurveIsValid())
                    continue;
                string id;
                try
                {
                    id = TrackId(track);
                }
                catch
                {
                    continue;
                }
                if (string.IsNullOrEmpty(id) || coords.Property(id) != null)
                    continue;
                var sample = SampleTrack(track);
                if (sample.Count == 0)
                    continue;
                trackIds[track] = id;
                coords[id] = sample;
            }

            var junctionsJson = new JArray();
            var junctions = RailTrackRegistry.Instance.OrderedJunctions;
            for (int i = 0; i < junctions.Length; i++)
            {
                var junction = junctions[i];
                var inPort = Port(junction.inBranch, trackIds);
                if (inPort == null)
                    continue;
                var branches = new JArray();
                for (int branchIndex = 0; branchIndex < junction.outBranches.Count; branchIndex++)
                {
                    var port = Port(junction.outBranches[branchIndex], trackIds);
                    if (port != null)
                    {
                        port["branch"] = branchIndex;
                        branches.Add(port);
                    }
                }
                if (branches.Count == 0)
                    continue;
                junctionsJson.Add(new JObject
                {
                    ["id"] = i,
                    ["position"] = new World.Position(junction.position - WorldMover.currentMove).ToLatLon().ToJson(),
                    ["in"] = inPort,
                    ["branches"] = branches,
                });
            }

            var links = new JArray();
            var seenLinks = new HashSet<string>();
            foreach (var kvp in trackIds)
            {
                var track = kvp.Key;
                var id = kvp.Value;
                if (track.inJunction == null && track.inBranch != null)
                {
                    var a = new JObject { ["track"] = id, ["end"] = "in" };
                    var b = Port(track.inBranch, trackIds);
                    if (b != null)
                    {
                        var key = string.CompareOrdinal(PortKey(a), PortKey(b)) < 0
                            ? PortKey(a) + "\u0002" + PortKey(b)
                            : PortKey(b) + "\u0002" + PortKey(a);
                        if (seenLinks.Add(key))
                            links.Add(new JObject { ["a"] = a, ["b"] = b });
                    }
                }
                if (track.outJunction == null && track.outBranch != null)
                {
                    var a = new JObject { ["track"] = id, ["end"] = "out" };
                    var b = Port(track.outBranch, trackIds);
                    if (b != null)
                    {
                        var key = string.CompareOrdinal(PortKey(a), PortKey(b)) < 0
                            ? PortKey(a) + "\u0002" + PortKey(b)
                            : PortKey(b) + "\u0002" + PortKey(a);
                        if (seenLinks.Add(key))
                            links.Add(new JObject { ["a"] = a, ["b"] = b });
                    }
                }
            }

            return new JObject
            {
                ["version"] = 1,
                ["generatedAt"] = DateTime.UtcNow.ToString("o"),
                ["coords"] = coords,
                ["junctions"] = junctionsJson,
                ["links"] = links,
            };
        }

        private static async Task<string> GetTopologyJsonAsync()
        {
            if (topologyJson != null)
                return topologyJson;
            if (!WorldStreamingInit.Instance)
                throw new Exception("World not yet loaded");
            if (!WorldStreamingInit.IsLoaded)
            {
                var tcs = new TaskCompletionSource<bool>();
                WorldStreamingInit.LoadingFinished += () => tcs.TrySetResult(true);
                await tcs.Task.ConfigureAwait(false);
            }
            var json = await Updater.RunOnMainThread(GenerateTopology).ConfigureAwait(false);
            topologyJson = json.ToString(Newtonsoft.Json.Formatting.None);
            return topologyJson;
        }

        public static async Task<string> GetTopologyJSON()
        {
            return await GetTopologyJsonAsync().ConfigureAwait(false);
        }

        public static async Task<string> GetTrackPointJSON()
        {
            if (trackPointJson != null)
                return trackPointJson;
            var root = JObject.Parse(await GetTopologyJsonAsync().ConfigureAwait(false));
            trackPointJson = (root["coords"] ?? new JObject()).ToString(Newtonsoft.Json.Formatting.None);
            return trackPointJson;
        }

        public static string GetJunctionPointJSON()
        {
            if (!WorldStreamingInit.Instance || !WorldStreamingInit.IsLoaded)
                throw new Exception("World not yet loaded");
            if (string.IsNullOrEmpty(junctionPointJson))
            {
                junctionPointJson = Newtonsoft.Json.JsonConvert.SerializeObject(
                    RailTrackRegistry.Instance.OrderedJunctions.Select(j =>
                    {
                        var moved = j.position - WorldMover.currentMove;
                        return new JObject(
                            new JProperty("position", new World.Position(moved.x, moved.z).ToLatLon().ToJson()),
                            new JProperty("branches", j.outBranches
                                .Where(b => b != null && b.track != null)
                                .Select(b => b.track.LogicTrack().ID.FullDisplayID))
                        );
                    })
                );
            }
            return junctionPointJson;
        }

        public static IEnumerable<byte> GetAllJunctionStates()
        {
            if (!WorldStreamingInit.Instance || !WorldStreamingInit.IsLoaded)
                throw new Exception("World not yet loaded");
            return RailTrackRegistry.Instance.OrderedJunctions.Select(j => j.selectedBranch);
        }

        public static string GetJunctionStateJSON()
        {
            return Newtonsoft.Json.JsonConvert.SerializeObject(GetAllJunctionStates());
        }
    }

    public static class Junctions
    {
        public static string GetJunctionPointJSON() => RailTracks.GetJunctionPointJSON();

        public static IEnumerable<byte> GetAllJunctionStates() => RailTracks.GetAllJunctionStates();

        public static string GetJunctionStateJSON() => RailTracks.GetJunctionStateJSON();
    }
}
