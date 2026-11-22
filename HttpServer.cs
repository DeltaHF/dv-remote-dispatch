using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System.IO.Compression;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using System;
using System.Collections.Generic;
using UnityEngine;

namespace DvMod.RemoteDispatch_BT
{
    public class HttpServer : MonoBehaviour
    {
        private static GameObject? rootObject;
        private readonly HttpListener listener = new HttpListener();

        public async void Start()
        {
            if (!listener.IsListening)
            {
                listener.Prefixes.Add($"http://*:{Main.settings.serverPort}/");
                listener.AuthenticationSchemes = AuthenticationSchemes.Anonymous | AuthenticationSchemes.Basic;
                listener.Realm = "DV Remote Dispatch";
                Main.DebugLog(() => $"Starting HTTP server on port {Main.settings.serverPort}");
                listener.Start();
            }

            while (listener.IsListening)
            {
                try
                {
                    var context = await listener.GetContextAsync().ConfigureAwait(true);
                    if (CheckAuthentication(context))
                    {
                        _ = Task.Run(async () =>
                        {
                            try
                            {
                                await HandleRequest(context).ConfigureAwait(false);
                            }
                            catch (Exception e)
                            {
                                Main.DebugLog(() => $"Exception while handling HTTP request ({context.Request.Url}): {e}");
                            }
                        });
                    }
                    else
                    {
                        context.Response.Headers.Add("WWW-Authenticate", "Basic");
                        RenderEmpty(context, 401);
                    }
                }
                catch (ObjectDisposedException e) when (e.ObjectName == "listener")
                {
                    // ignore when OnDestroy() is called to shutdown the server
                }
            }
        }

        public void OnDestroy()
        {
            if (listener.IsListening)
            {
                Main.DebugLog(() => "Stopping HTTP server");
                listener.Stop();
                listener.Prefixes.Clear();
            }
        }

        private static bool CheckAuthentication(HttpListenerContext context)
        {
            string serverPassword = Main.settings.serverPassword;
            return context.User?.Identity is HttpListenerBasicIdentity identity && (string.IsNullOrEmpty(serverPassword) || identity.Password == serverPassword);
        }

        private static async Task HandleRequest(HttpListenerContext context)
        {
            var request = context.Request;
            if (request.Url.Segments.Length < 2)
            {
                context.Response.ContentType = ContentTypes.Html;
                RenderResource(context, "index.html");
                return;
            }

            switch (request.Url.Segments[1].TrimEnd('/'))
            {
            case "assignments":
                HandleAssignmentsRequest(context);
                break;
            case "car":
                HandleCarRequest(context);
                break;
            case "config":
                Render200(context, ContentTypes.Json, WebConfig.GetConfigJson());
                break;
            case "job":
                Render200(context, ContentTypes.Json, JobData.GetAllJobDataJson());
                break;
            case "junction":
                HandleJunctionRequest(context);
                break;
            case "junctionState":
                Render200(context, ContentTypes.Json, Junctions.GetJunctionStateJSON());
                break;
            case "permissions":
                Render200(context, ContentTypes.Json,
                    DispatchAssignments.GetPermissions(context.User?.Identity?.Name ?? "").ToString());
                break;
            case "player":
                var playerJson = PlayerData.GetPlayerDataJson();
                if (playerJson != null)
                    Render200(context, ContentTypes.Json, playerJson);
                else
                    RenderEmpty(context, 500);
                break;
            case "res":
                RenderResource(context);
                break;
            case "stations":
                if (!WorldStreamingInit.Instance || !WorldStreamingInit.IsLoaded)
                {
                    RenderEmpty(context, 503);
                    break;
                }
                Render200(context, ContentTypes.Json, JsonConvert.SerializeObject(
                    await Updater.RunOnMainThread(() => StationData.GetStationData(context.Request.QueryString["lang"])).ConfigureAwait(false)));
                break;
            case "railSigns":
                Render200(context, ContentTypes.Json, await RailSigns.GetSignsJSON().ConfigureAwait(false));
                break;
            case "track":
                Render200(context, ContentTypes.Json, await RailTracks.GetTrackPointJSON().ConfigureAwait(false));
                break;
            case "topology":
                Render200(context, ContentTypes.Json, await RailTracks.GetTopologyJSON().ConfigureAwait(false));
                break;
            case "trainset":
                HandleTrainsetRequest(context);
                break;
            case "updates":
                await HandleUpdatesRequest(context).ConfigureAwait(false);
                break;
            default:
                RenderEmpty(context, 404);
                break;
            }
        }

        private static void HandleCarRequest(HttpListenerContext context)
        {
            var segments = context.Request.Url.Segments;
            if (segments.Length == 2 && context.Request.HttpMethod == "GET")
            {
                var allCarDataJson = CarData.GetAllCarDataJson();
                Render200(context, allCarDataJson);
                return;
            }

            if (segments.Length == 3 && context.Request.HttpMethod == "GET")
            {
                var carGuid = segments[2].TrimEnd('/');
                var carDataJson = CarData.GetCarGuidDataJson(carGuid);
                if (carDataJson == null)
                    RenderEmpty(context, 404);
                else
                    Render200(context, carDataJson);
                return;
            }

            if (segments.Length == 4 && segments[3] == "control" && context.Request.HttpMethod == "POST")
            {
                // Locomotive remote control is intentionally disabled. The webpage no
                // longer exposes it, and direct requests must not reach the game.
                Main.DebugLog(() => "Rejected disabled locomotive control request.");
                RenderEmpty(context, 403);
                return;
            }
            RenderEmpty(context, 404);
        }

        private static void RenderJson(HttpListenerContext context, int statusCode, JToken json)
        {
            context.Response.StatusCode = statusCode;
            Render200(context, ContentTypes.Json, json.ToString(Newtonsoft.Json.Formatting.None));
        }

        private static void HandleAssignmentsRequest(HttpListenerContext context)
        {
            if (context.Request.HttpMethod != "POST")
            {
                RenderJson(context, 200, DispatchAssignments.GetSnapshot());
                return;
            }

            var username = context.User?.Identity?.Name ?? "";
            if (!Main.settings.permissions.HasAdministratorPermission(username))
            {
                RenderEmpty(context, 403);
                return;
            }

            var query = context.Request.QueryString;
            var op = query["op"] ?? "";
            var jobId = query["job"] ?? "";
            var player = query["player"] ?? "";
            var playerName = query["playerName"] ?? "";
            var session = query["session"] ?? "";
            long revision;
            if (!long.TryParse(query["revision"], out revision))
                revision = -1;

            if (!string.IsNullOrEmpty(session) && session != DispatchAssignments.WorldSession)
            {
                RenderJson(context, 409, new JObject
                {
                    ["error"] = "session",
                    ["snapshot"] = DispatchAssignments.GetSnapshot(),
                });
                return;
            }

            string? error;
            JObject snapshot;
            switch (op)
            {
            case "assign":
                snapshot = DispatchAssignments.Assign(jobId, player, playerName, revision, out error);
                break;
            case "unassign":
                snapshot = DispatchAssignments.Unassign(jobId, revision, out error);
                break;
            case "release":
                snapshot = DispatchAssignments.ReleasePlayer(player, revision, out error);
                break;
            default:
                RenderEmpty(context, 400);
                return;
            }

            if (error != null)
            {
                RenderJson(context, error == "revision" ? 409 : 400, new JObject
                {
                    ["error"] = error,
                    ["snapshot"] = snapshot,
                });
                return;
            }
            RenderJson(context, 200, snapshot);
        }

        private static async Task HandleUpdatesRequest(HttpListenerContext context)
        {
            if (context.Request.Url.Segments.Length < 3)
            {
                RenderEmpty(context, 404);
                return;
            }

            var username = context.User?.Identity?.Name ?? "";
            var sessionId = context.Request.Url.Segments[2];
            Render200(context, ContentTypes.Json, await Sessions.GetUpdates(username, sessionId).ConfigureAwait(false));
        }

        private static bool IsValidJunctionId(int junctionId)
        {
            return junctionId >= 0 && junctionId < RailTrackRegistry.Instance.OrderedJunctions.Length;
        }

        private static List<(int id, int branch)> ParseJunctionPairs(string? pairs)
        {
            var validPairs = new List<(int id, int branch)>();
            if (pairs == null || pairs.Length == 0)
                return validPairs;
            var skipped = 0;
            foreach (var pair in pairs.Split(','))
            {
                var parts = pair.Split(':');
                if (parts.Length == 2
                    && int.TryParse(parts[0], out var id)
                    && IsValidJunctionId(id)
                    && int.TryParse(parts[1], out var branch)
                    && branch >= 0
                    && branch < RailTrackRegistry.Instance.OrderedJunctions[id].outBranches.Count)
                {
                    validPairs.Add((id, branch));
                }
                else
                {
                    skipped++;
                }
            }
            if (skipped > 0)
                Main.DebugLog(() => $"Skipped {skipped} invalid pair(s) in junction set request.");
            return validPairs;
        }

        private static async void HandleJunctionRequest(HttpListenerContext context)
        {
            var url = context.Request.Url;
            switch (url.Segments.Length)
            {
            case 2:
                Render200(context, ContentTypes.Json, Junctions.GetJunctionPointJSON());
                break;
            case 3:
                if (url.Segments[2].TrimEnd('/') == "set" && context.Request.HttpMethod == "POST")
                {
                    if (!Main.settings.permissions.HasJunctionPermission(context.User.Identity.Name))
                    {
                        RenderEmpty(context, 403);
                        return;
                    }
                    var validPairs = ParseJunctionPairs(context.Request.QueryString["pairs"]);
                    if (validPairs.Count == 0)
                    {
                        RenderEmpty(context, 400);
                        return;
                    }
                    var junctionStates = await Updater.RunOnMainThread(() =>
                    {
                        var results = new JArray();
                        foreach (var (id, branch) in validPairs)
                        {
                            Main.DebugLog(() => $"Setting J-{id} to branch {branch}.");
                            try
                            {
                                var junction = RailTrackRegistry.Instance.OrderedJunctions[id];
                                if (junction.selectedBranch != branch)
                                    junction.Switch(Junction.SwitchMode.REGULAR, (byte)branch);
                                var actual = junction.selectedBranch;
                                results.Add(new JObject
                                {
                                    ["junctionId"] = id,
                                    ["requestedBranch"] = branch,
                                    ["selectedBranch"] = actual,
                                    ["success"] = actual == branch,
                                });
                            }
                            catch (Exception e)
                            {
                                results.Add(new JObject
                                {
                                    ["junctionId"] = id,
                                    ["requestedBranch"] = branch,
                                    ["selectedBranch"] = null,
                                    ["success"] = false,
                                    ["error"] = e.GetType().Name,
                                });
                                Main.DebugLog(() => $"Failed to set J-{id} to branch {branch}: {e.Message}");
                            }
                        }
                        return results;
                    }).ConfigureAwait(false);
                    Render200(context, junctionStates);
                    return;
                }
                RenderEmpty(context, 404);
                break;
            case 4:
                var junctionIdString = url.Segments[2].TrimEnd('/');
                if (int.TryParse(junctionIdString, out var junctionId) && url.Segments[3] == "toggle" && IsValidJunctionId(junctionId))
                {
                    if (!Main.settings.permissions.HasJunctionPermission(context.User.Identity.Name))
                    {
                        RenderEmpty(context, 403);
                        return;
                    }
                    var newSelectedBranch = await Updater.RunOnMainThread(() =>
                    {
                        Main.DebugLog(() => $"Toggling J-{junctionId}.");
                        var junction = RailTrackRegistry.Instance.OrderedJunctions[junctionId];
                        junction.Switch(Junction.SwitchMode.REGULAR);
                        return junction.selectedBranch;
                    }).ConfigureAwait(false);
                    Render200(context, new JValue(newSelectedBranch));
                    return;
                }
                RenderEmpty(context, 404);
                break;
            default:
                RenderEmpty(context, 404);
                break;
            }
        }

        public static void HandleTrainsetRequest(HttpListenerContext context)
        {
            var request = context.Request;
            if (request.Url.Segments.Length < 3)
            {
                RenderEmpty(context, 404);
                return;
            }
            var trainsetId = int.Parse(request.Url.Segments[2]);
            Render200(context, CarData.GetTrainsetDataJson(trainsetId));
        }

        public static void Create()
        {
            if (rootObject == null)
            {
                rootObject = new GameObject();
                GameObject.DontDestroyOnLoad(rootObject);
                rootObject.AddComponent<HttpServer>();
            }
        }

        public static void Destroy()
        {
            if (rootObject == null)
                return;
            // ensure server shuts down immediately, not at the end of the frame
            DestroyImmediate(rootObject);
            rootObject = null;
        }

        private static void RenderResource(HttpListenerContext context)
        {
            var resourceName = context.Request.Url.Segments[2];
            var extension = Path.GetExtension(resourceName);
            context.Response.ContentType = ContentTypes.ForExtension(extension);
            RenderResource(context, resourceName);
        }

        private static void RenderResource(HttpListenerContext context, string resourceName)
        {
            var assembly = typeof(HttpServer).Assembly;
            using var stream = assembly.GetManifestResourceStream(typeof(HttpServer), resourceName);
            if (stream == null)
            {
                RenderEmpty(context, 404);
            }
            else
            {
                stream.CopyTo(context.Response.OutputStream);
                context.Response.Close();
            }
        }

        private static class ContentTypes
        {
            public const string Css = "text/css";
            public const string Html = "text/html; charset=UTF-8";
            public const string Json = "application/json";
            public const string Javascript = "application/javascript";
            public const string Jpeg = "image/jpeg";
            public const string Png = "image/png";
            public const string Svg = "image/svg+xml";

            public static string ForExtension(string extension)
            {
                return extension switch
                {
                    ".css" => Css,
                    ".js" => Javascript,
                    ".json" => Json,
                    ".jpg" => Jpeg,
                    ".jpeg" => Jpeg,
                    ".png" => Png,
                    ".svg" => Svg,
                    _ => "",
                };
            }
        }

        private static void Render200(HttpListenerContext context, JToken json)
        {
            Render200(context, ContentTypes.Json, JsonConvert.SerializeObject(json));
        }

        private static void Render200(HttpListenerContext context, string contentType, string s)
        {
            context.Response.ContentType = contentType;
            if (contentType == ContentTypes.Json)
                context.Response.Headers.Add("Cache-Control", "no-store");
            var bytes = Encoding.UTF8.GetBytes(s);
            if (bytes.Length > 128 && (context.Request.Headers.GetValues("Accept-Encoding")?.Contains("gzip") ?? false))
            {
                context.Response.Headers.Add("Content-Encoding", "gzip");
                var mem = new MemoryStream(bytes);
                using var gzip = new GZipStream(context.Response.OutputStream, CompressionMode.Compress);
                mem.CopyTo(gzip);
            }
            else
            {
                context.Response.Close(bytes, false);
            }
        }

        private static void RenderEmpty(HttpListenerContext context, int statusCode)
        {
            context.Response.StatusCode = statusCode;
            context.Response.Close();
        }
    }
}
