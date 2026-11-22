using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DvMod.RemoteDispatch_BT
{
    public static class PlayerData
    {
        private static World.Position previousPosition;
        private static float previousRotation;
        private static readonly Dictionary<string, (World.Position position, float rotation, string displayName)> mpPlayerStates =
            new Dictionary<string, (World.Position, float, string)>();

        // keep in sync with carColors in main.js
        private static readonly string[] playerColors = {
            "#52ef99", "#c95e9f", "#b1e632", "#7574f5", "#799d10", "#fd3fbe", "#2cf52b", "#d130ff", "#21a708", "#fd2b31",
            "#3eeaef", "#ffc4de", "#069668", "#f9793b", "#5884c9", "#e5d75e", "#96ccfe", "#bb8801", "#6a8b7b", "#a8777c",
        };

        private static string ColorForUsername(string username)
        {
            unchecked
            {
                uint hash = 5381;
                for (int i = username.Length - 1; i >= 0; i--)
                    hash = (hash * 33) ^ username[i];
                return playerColors[hash % playerColors.Length];
            }
        }

        public static void CheckTransform()
        {
            if (MultiplayerIntegration.IsAvailable())
            {
                CheckMultiplayerTransforms();
                return;
            }
            CheckLocalTransform();
        }

        private static void CheckLocalTransform()
        {
            var transform = PlayerManager.PlayerTransform;
            if (transform == null)
                return;
            var position = new World.Position(transform.position - WorldMover.currentMove);
            var rotation = transform.eulerAngles.y;
            if (!(
                ApproximatelyEquals(previousPosition.x, position.x)
                && ApproximatelyEquals(previousPosition.z, position.z)
                && ApproximatelyEquals(previousRotation, rotation)))
            {
                Sessions.AddTag("player");
                previousPosition = position;
                previousRotation = rotation;
            }
        }

        private static void CheckMultiplayerTransforms()
        {
            if (!MultiplayerIntegration.TryGetPlayers(out var players))
                return;

            if (players.Count == 0)
            {
                if (mpPlayerStates.Count > 0)
                {
                    mpPlayerStates.Clear();
                    Sessions.AddTag("player");
                }
                var active = MultiplayerIntegration.IsDedicatedServer()
                    ? new HashSet<string>()
                    : new HashSet<string> { "player" };
                DispatchAssignments.ReconcileActivePlayers(active);
                CheckLocalTransform();
                return;
            }

            DispatchAssignments.ReconcileActivePlayers(players.Select(p => p.username));
            var changed = players.Count != mpPlayerStates.Count;
            var seen = new HashSet<string>();
            foreach (var player in players)
            {
                seen.Add(player.username);
                if (mpPlayerStates.TryGetValue(player.username, out var state))
                {
                    if (!(
                        ApproximatelyEquals(state.position.x, player.position.x)
                        && ApproximatelyEquals(state.position.z, player.position.z)
                        && ApproximatelyEquals(state.rotation, player.rotationY)
                        && state.displayName == player.displayName))
                    {
                        changed = true;
                    }
                }
                else
                {
                    changed = true;
                }
                mpPlayerStates[player.username] = (player.position, player.rotationY, player.displayName);
            }
            foreach (var username in new List<string>(mpPlayerStates.Keys))
            {
                if (!seen.Contains(username))
                {
                    mpPlayerStates.Remove(username);
                    changed = true;
                }
            }
            if (changed)
                Sessions.AddTag("player");
        }

        private static bool ApproximatelyEquals(float f1, float f2)
        {
            var delta = f1 - f2;
            return delta > -1e-3 && delta < 1e-3;
        }

        public static JObject GetPlayerData()
        {
            CheckTransform();
            var players = MultiplayerIntegration.GetPlayers();
            if (players.Count > 0)
            {
                var obj = new JObject();
                var localUsername = MultiplayerIntegration.TryGetLocalPlayerUsername();
                foreach (var player in players)
                {
                    var entry = new JObject(
                        new JProperty("displayName", player.displayName),
                        new JProperty("color", ColorForUsername(player.username)),
                        new JProperty("position", player.position.ToLatLon().ToJson()),
                        new JProperty("rotation", Math.Round(player.rotationY, 2))
                    );
                    if (localUsername != null && string.Equals(player.username, localUsername, StringComparison.Ordinal))
                        entry["local"] = true;
                    obj.Add(player.username, entry);
                }
                return obj;
            }
            if (MultiplayerIntegration.IsDedicatedServer())
                return new JObject();
            var localPlayer = new JObject(
                new JProperty("color", "aqua"),
                new JProperty("position", previousPosition.ToLatLon().ToJson()),
                new JProperty("rotation", Math.Round(previousRotation, 2)),
                new JProperty("local", true)
            );
            var localPlayerName = MultiplayerIntegration.TryGetLocalPlayerName();
            if (localPlayerName != null)
                localPlayer.Add(new JProperty("displayName", localPlayerName));
            return new JObject(
                new JProperty("player", localPlayer)
            );
        }

        public static string GetPlayerDataJson()
        {
            return JsonConvert.SerializeObject(GetPlayerData());
        }
    }
}
