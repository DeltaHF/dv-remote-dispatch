using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DvMod.RemoteDispatch
{
    public static class PlayerData
    {
        private static World.Position previousPosition;
        private static float previousRotation;
        private static readonly Dictionary<string, (World.Position position, float rotation)> mpPlayerStates =
            new Dictionary<string, (World.Position, float)>();

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
            var players = MultiplayerIntegration.GetPlayers();
            if (players.Count == 0)
            {
                CheckLocalTransform();
                return;
            }

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
                        && ApproximatelyEquals(state.rotation, player.rotationY)))
                    {
                        changed = true;
                    }
                }
                else
                {
                    changed = true;
                }
                mpPlayerStates[player.username] = (player.position, player.rotationY);
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
                foreach (var player in players)
                {
                    obj.Add(player.username, new JObject(
                        new JProperty("displayName", player.displayName),
                        new JProperty("color", ColorForUsername(player.username)),
                        new JProperty("position", player.position.ToLatLon().ToJson()),
                        new JProperty("rotation", Math.Round(player.rotationY, 2))
                    ));
                }
                return obj;
            }
            return new JObject(
                new JProperty("player", new JObject(
                    new JProperty("color", "aqua"),
                    new JProperty("position", previousPosition.ToLatLon().ToJson()),
                    new JProperty("rotation", Math.Round(previousRotation, 2))
                ))
            );
        }

        public static string GetPlayerDataJson()
        {
            return JsonConvert.SerializeObject(GetPlayerData());
        }
    }
}
