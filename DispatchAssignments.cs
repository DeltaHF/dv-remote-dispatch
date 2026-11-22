using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;

namespace DvMod.RemoteDispatch_BT
{
    /// <summary>
    /// Room-scoped, server-authoritative player/job assignment state.
    /// Assignments live only for the current world session; they are intentionally
    /// not written to the save file and are cleared on world start/stop.
    /// </summary>
    public static class DispatchAssignments
    {
        private sealed class Assignment
        {
            public readonly string jobId;
            public string player;
            public string playerName;
            public long order;

            public Assignment(string jobId, string player, string playerName, long order)
            {
                this.jobId = jobId;
                this.player = player;
                this.playerName = playerName;
                this.order = order;
            }
        }

        private sealed class PendingOffline
        {
            public readonly Stopwatch elapsed = Stopwatch.StartNew();
        }

        private static readonly object sync = new object();
        private static readonly List<Assignment> assignments = new List<Assignment>();
        private static readonly Dictionary<string, PendingOffline> pendingOffline =
            new Dictionary<string, PendingOffline>();

        private const int OfflineGraceSeconds = 5;

        private static long revision;
        private static long nextOrder = 1;
        private static string worldSession = "";

        public static string WorldSession
        {
            get { lock (sync) return worldSession; }
        }

        public static void BeginWorld()
        {
            lock (sync)
            {
                if (!string.IsNullOrEmpty(worldSession))
                    return;
                worldSession = Guid.NewGuid().ToString("N");
                assignments.Clear();
                pendingOffline.Clear();
                revision = 0;
                nextOrder = 1;
            }
            Sessions.AddTag("assignments");
        }

        public static void EndWorld()
        {
            bool changed;
            lock (sync)
            {
                changed = assignments.Count > 0 || !string.IsNullOrEmpty(worldSession);
                assignments.Clear();
                pendingOffline.Clear();
                revision = 0;
                nextOrder = 1;
                worldSession = "";
            }
            if (changed)
                Sessions.AddTag("assignments");
        }

        private static JObject SnapshotLocked()
        {
            var array = new JArray();
            foreach (var assignment in assignments.OrderBy(a => a.order))
            {
                array.Add(new JObject
                {
                    ["jobId"] = assignment.jobId,
                    ["player"] = assignment.player,
                    ["playerName"] = assignment.playerName,
                    ["order"] = assignment.order,
                });
            }
            return new JObject
            {
                ["session"] = worldSession,
                ["revision"] = revision,
                ["assignments"] = array,
            };
        }

        public static JObject GetSnapshot()
        {
            lock (sync)
                return SnapshotLocked();
        }

        private static void ChangedLocked()
        {
            revision++;
        }

        private static bool RevisionMatches(long expectedRevision)
        {
            return expectedRevision < 0 || expectedRevision == revision;
        }

        public static JObject Assign(string jobId, string player, string playerName, long expectedRevision,
            out string? error)
        {
            error = null;
            if (string.IsNullOrWhiteSpace(jobId) || string.IsNullOrWhiteSpace(player))
            {
                error = "missing-job-or-player";
                return GetSnapshot();
            }
            lock (sync)
            {
                if (!RevisionMatches(expectedRevision))
                {
                    error = "revision";
                    return SnapshotLocked();
                }
                if (string.IsNullOrEmpty(playerName))
                    playerName = player;
                var existing = assignments.FirstOrDefault(a => a.jobId == jobId);
                if (existing != null)
                {
                    if (existing.player == player)
                    {
                        if (existing.playerName == playerName)
                            return SnapshotLocked();
                        existing.playerName = playerName;
                    }
                    else
                    {
                        existing.player = player;
                        existing.playerName = playerName;
                        existing.order = nextOrder++;
                    }
                }
                else
                {
                    assignments.Add(new Assignment(jobId, player, playerName, nextOrder++));
                }
                pendingOffline.Remove(player);
                ChangedLocked();
            }
            Sessions.AddTag("assignments");
            return GetSnapshot();
        }

        public static JObject Unassign(string jobId, long expectedRevision, out string? error)
        {
            error = null;
            lock (sync)
            {
                if (!RevisionMatches(expectedRevision))
                {
                    error = "revision";
                    return SnapshotLocked();
                }
                var removed = assignments.RemoveAll(a => a.jobId == jobId);
                if (removed > 0)
                    ChangedLocked();
            }
            Sessions.AddTag("assignments");
            return GetSnapshot();
        }

        public static JObject ReleasePlayer(string player, long expectedRevision, out string? error)
        {
            error = null;
            lock (sync)
            {
                if (string.IsNullOrEmpty(player))
                {
                    error = "missing-player";
                    return SnapshotLocked();
                }
                if (!RevisionMatches(expectedRevision))
                {
                    error = "revision";
                    return SnapshotLocked();
                }
                var removed = assignments.RemoveAll(a => a.player == player);
                if (removed > 0)
                    ChangedLocked();
                pendingOffline.Remove(player);
            }
            Sessions.AddTag("assignments");
            return GetSnapshot();
        }

        /// <summary>Remove assignments whose job no longer exists in the live job snapshot.</summary>
        public static void PruneMissingJobs(IEnumerable<string> liveJobIds)
        {
            var live = new HashSet<string>(liveJobIds);
            bool changed;
            lock (sync)
            {
                changed = assignments.RemoveAll(a => !live.Contains(a.jobId)) > 0;
                if (changed)
                    ChangedLocked();
            }
            if (changed)
            {
                Sessions.AddTag("assignments");
                Sessions.AddTag("jobs");
            }
        }

        public static void RemoveJob(string jobId)
        {
            bool changed;
            lock (sync)
                changed = assignments.RemoveAll(a => a.jobId == jobId) > 0;
            if (changed)
            {
                Sessions.AddTag("assignments");
                Sessions.AddTag("jobs");
            }
        }

        /// <summary>
        /// Release players that have been absent for a grace period. The caller must
        /// only pass ids from a successful player snapshot; transient collection errors
        /// must not reach this method.
        /// </summary>
        public static void ReconcileActivePlayers(IEnumerable<string> activePlayerIds)
        {
            var active = new HashSet<string>(activePlayerIds);
            bool changed = false;
            lock (sync)
            {
                foreach (var player in assignments.Select(a => a.player).Distinct().ToList())
                {
                    if (active.Contains(player))
                    {
                        pendingOffline.Remove(player);
                        continue;
                    }
                    if (!pendingOffline.TryGetValue(player, out var pending))
                    {
                        pendingOffline[player] = new PendingOffline();
                        continue;
                    }
                    if (pending.elapsed.Elapsed.TotalSeconds < OfflineGraceSeconds)
                        continue;
                    if (assignments.RemoveAll(a => a.player == player) > 0)
                    {
                        changed = true;
                        pendingOffline.Remove(player);
                        Main.DebugLog(() => $"Released assignments for offline player {player}");
                    }
                }
            }
            if (changed)
                Sessions.AddTag("assignments");
        }

        public static JObject GetPermissions(string username)
        {
            username = username ?? "";
            return new JObject
            {
                ["username"] = username,
                ["administrator"] = Main.settings.permissions.HasAdministratorPermission(username),
                ["junctions"] = Main.settings.permissions.HasJunctionPermission(username),
            };
        }
    }
}
