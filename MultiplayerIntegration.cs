using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using UnityEngine;

namespace DvMod.RemoteDispatch
{
    public readonly struct RemotePlayerInfo
    {
        public readonly string username;
        public readonly string displayName;
        public readonly World.Position position;
        public readonly float rotationY;

        public RemotePlayerInfo(string username, string displayName, World.Position position, float rotationY)
        {
            this.username = username;
            this.displayName = displayName;
            this.position = position;
            this.rotationY = rotationY;
        }
    }

    public static class MultiplayerIntegration
    {
        private static bool? available;

        public static bool IsAvailable()
        {
            if (available == null)
            {
                try
                {
                    available = CheckAvailable();
                }
                catch (Exception e)
                {
                    Main.DebugLog(() => $"Multiplayer API not available: {e.GetType().Name}");
                    available = false;
                }
            }
            return available.Value;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static bool CheckAvailable()
        {
            return MPAPI.MultiplayerAPI.IsMultiplayerLoaded;
        }

        public static List<RemotePlayerInfo> GetPlayers()
        {
            var result = new List<RemotePlayerInfo>();
            if (!IsAvailable())
                return result;
            try
            {
                CollectPlayers(result);
            }
            catch (Exception e)
            {
                Main.DebugLog(() => $"Failed to collect multiplayer players: {e}");
            }
            return result;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void CollectPlayers(List<RemotePlayerInfo> result)
        {
            var client = MPAPI.MultiplayerAPI.Client;
            if (client == null || !client.IsConnected)
                return;
            foreach (var player in client.Players)
            {
                var worldPos = player.Position - WorldMover.currentMove;
                var username = player.Username;
                var displayName = string.IsNullOrEmpty(player.DisplayName) ? username : player.DisplayName;
                result.Add(new RemotePlayerInfo(
                    username,
                    displayName,
                    new World.Position(worldPos.x, worldPos.z),
                    player.RotationY));
            }
        }
    }
}
