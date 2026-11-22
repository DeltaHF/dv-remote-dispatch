using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DvMod.RemoteDispatch_BT
{
    public static class Sessions
    {
        private static readonly TimeSpan SessionTimeout = TimeSpan.FromMinutes(5);
        private static readonly object allSesssionsLock = new object();
        private static readonly Dictionary<string, Session> allSessions = new Dictionary<string, Session>();
        private static readonly HashSet<string> AllTags = new HashSet<string>() { "cars", "jobs", "junctions", "player", "assignments", "permissions" };

        public static event Action<string>? OnSessionStarted;
        public static event Action<string>? OnSessionEnded;

        /// <summary>
        /// Forget browser sessions. Called on world start/stop so the next poll
        /// receives a full snapshot of the new room instead of stale tags.
        /// </summary>
        public static void Reset()
        {
            lock (allSesssionsLock)
            {
                // Wake up long-poll requests before dropping the sessions; otherwise a
                // browser waiting on the old world could take up to a minute to notice
                // that the room was replaced.
                foreach (var session in allSessions.Values)
                    session.pendingTags.Add("assignments");
                allSessions.Clear();
            }
        }

        private class Session
        {
            public readonly string username;
            public readonly AsyncSet<string> pendingTags = new AsyncSet<string>();
            public readonly Stopwatch timeSinceLastFetch = new Stopwatch();

            public Session(string username)
            {
                this.username = username;
                foreach (var tag in AllTags)
                    pendingTags.Add(tag);
            }
        }

        public static HashSet<string> GetUsersWithActiveSessions()
        {
            return new HashSet<string>(allSessions.Values.Select(s => s.username));
        }

        public static void AddTag(string tag)
        {
            lock (allSesssionsLock)
            {
                List<string> timedOutSessions = new List<string>();
                foreach (var kvp in allSessions)
                {
                    var sessionId = kvp.Key;
                    var session = kvp.Value;
                    if (session.timeSinceLastFetch.Elapsed > SessionTimeout)
                        timedOutSessions.Add(sessionId);
                    else
                        session.pendingTags.Add(tag);
                }
                foreach (var sessionId in timedOutSessions)
                {
                    Main.DebugLog(() => $"Session {sessionId} timed out");
                    allSessions.Remove(sessionId);
                    OnSessionEnded?.Invoke(sessionId);
                }
            }
        }

        private static async Task<IEnumerable<string>> GetTags(string username, string sessionId)
        {
            Session session;
            lock (allSesssionsLock)
            {
                if (!allSessions.TryGetValue(sessionId, out session))
                {
                    Main.DebugLog(() => $"Starting new session {sessionId} for user {username}");
                    session = new Session(username);
                    allSessions.Add(sessionId, session);
                    OnSessionStarted?.Invoke(username);
                }
            }

            session.timeSinceLastFetch.Restart();

            var tags = new HashSet<string>(session.pendingTags.TakeAll());
            if (tags.Count > 0)
                return tags;

            // No data available
            var (success, awaitedTag) = await session.pendingTags.TryTakeAsync(TimeSpan.FromMinutes(1)).ConfigureAwait(false);
            return success ? new string[1] { awaitedTag } : new string[0];
        }

        private static JObject? GetUpdateForCarGuid(string carGuid)
        {
            return CarData.GetCarGuidDataJson(carGuid);
        }

        private static JObject GetUpdateForTrainset(string trainsetId)
        {
            return JObject.FromObject(CarData.GetTrainsetData(int.Parse(trainsetId)));
        }

        private static JToken? GetUpdateForSplitTag(string tag)
        {
            var index = tag.IndexOf('-');
            var tagType = tag.Substring(0, index);
            var tagId = tag.Substring(index + 1);
            return tagType switch
            {
                "carguid" => GetUpdateForCarGuid(tagId),
                "trainset" => GetUpdateForTrainset(tagId),
                _ => throw new NotImplementedException($"Unexpected update tag {tag}"),
            };
        }

        private static JToken? GetUpdateForTag(string tag, string username)
        {
            return tag switch
            {
                "cars" => JObject.FromObject(CarData.GetAllCarData().ToDictionary(kvp => kvp.Key, kvp => kvp.Value.ToJson())),
                "jobs" => JObject.FromObject(JobData.GetAllJobData()),
                "junctions" => new JArray(Junctions.GetAllJunctionStates()),
                "player" => PlayerData.GetPlayerData(),
                "assignments" => DispatchAssignments.GetSnapshot(),
                "permissions" => DispatchAssignments.GetPermissions(username),
                _ when tag.Contains('-') => GetUpdateForSplitTag(tag),
                _ => throw new NotImplementedException($"Unexpected update tag {tag}"),
            };
        }

        public static async Task<string> GetUpdates(string username, string sessionId)
        {
            var tags = await GetTags(username, sessionId).ConfigureAwait(false);
            return JsonConvert.SerializeObject(tags.ToDictionary(tag => tag, tag => GetUpdateForTag(tag, username)));
        }
    }
}
