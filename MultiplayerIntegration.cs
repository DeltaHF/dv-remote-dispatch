using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using UnityEngine;

namespace DvMod.RemoteDispatch_BT
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
            TryGetPlayers(out var result);
            return result;
        }

        /// <summary>
        /// Returns false when the multiplayer API could not be queried. Callers that
        /// clean up player-owned state must not treat a failed query as "no players".
        /// </summary>
        public static bool TryGetPlayers(out List<RemotePlayerInfo> result)
        {
            result = new List<RemotePlayerInfo>();
            if (!IsAvailable())
                return true;
            try
            {
                CollectPlayers(result);
                return true;
            }
            catch (Exception e)
            {
                Main.DebugLog(() => $"Failed to collect multiplayer players: {e}");
                return false;
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void CollectPlayers(List<RemotePlayerInfo> result)
        {
            var usernames = new HashSet<string>();
            var client = MPAPI.MultiplayerAPI.Client;
            if (client != null && client.IsConnected)
            {
                foreach (var player in client.Players)
                    AddPlayer(result, usernames, player);
                var localPlayer = client.GetPlayer(client.PlayerId);
                if (localPlayer != null)
                    AddPlayer(result, usernames, localPlayer);
            }
            var server = MPAPI.MultiplayerAPI.Server;
            if (server != null)
            {
                foreach (var player in server.Players)
                    AddPlayer(result, usernames, player);
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void AddPlayer(List<RemotePlayerInfo> result, HashSet<string> usernames, MPAPI.Interfaces.IPlayer player)
        {
            var username = player.Username;
            if (string.IsNullOrEmpty(username) || !usernames.Add(username))
                return;
            var worldPos = player.Position - WorldMover.currentMove;
            result.Add(new RemotePlayerInfo(
                username,
                ResolveDisplayName(player),
                new World.Position(worldPos.x, worldPos.z),
                player.RotationY));
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static string ResolveDisplayName(MPAPI.Interfaces.IPlayer player)
        {
            if (!string.IsNullOrEmpty(player.DisplayName))
                return player.DisplayName;
            if (!string.IsNullOrEmpty(player.CrewName))
                return player.CrewName;
            return player.Username;
        }

        public static bool IsDedicatedServer()
        {
            if (!IsAvailable())
                return false;
            try
            {
                return CheckDedicatedServer();
            }
            catch (Exception e)
            {
                Main.DebugLog(() => $"Failed to check dedicated server status: {e}");
                return false;
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static bool CheckDedicatedServer()
        {
            return MPAPI.MultiplayerAPI.Instance != null && MPAPI.MultiplayerAPI.Instance.IsDedicatedServer;
        }

        public static string? TryGetLocalPlayerName()
        {
            if (!IsAvailable())
                return null;
            try
            {
                return GetLocalPlayerName();
            }
            catch (Exception e)
            {
                Main.DebugLog(() => $"Failed to get local player name: {e}");
                return null;
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static string? GetLocalPlayerName()
        {
            MPAPI.Interfaces.IPlayer? localPlayer = null;
            var client = MPAPI.MultiplayerAPI.Client;
            if (client != null && client.IsConnected)
                localPlayer = client.GetPlayer(client.PlayerId);
            if (localPlayer == null)
            {
                var server = MPAPI.MultiplayerAPI.Server;
                if (server != null)
                {
                    foreach (var player in server.Players)
                    {
                        if (player.IsHost)
                        {
                            localPlayer = player;
                            break;
                        }
                    }
                }
            }
            return localPlayer == null ? null : ResolveDisplayName(localPlayer);
        }
    }
}
