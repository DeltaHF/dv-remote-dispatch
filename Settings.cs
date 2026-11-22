using System.Linq;
using UnityModManagerNet;
using UnityEngine;
using System.Collections.Generic;
using System;

namespace DvMod.RemoteDispatch_BT
{
    public class Settings : UnityModManager.ModSettings
    {
        public int serverPort = 7245;
        public string serverPassword = "";
        public Permissions permissions = new Permissions();
        public bool showUndiscoveredLocomotives = false;
        public bool enableLogging = false;
        // Zero means the legacy Locomotive Control flags have not been migrated yet.
        public int permissionMigrationVersion = 0;

        public readonly string? version = Main.mod?.Info.Version;

        public void MigrateLegacyPermissions(UnityModManager.ModEntry entry)
        {
            if (permissionMigrationVersion >= 1)
                return;
            permissions.MigrateLegacyPermissions();
            permissionMigrationVersion = 1;
            try
            {
                Save(entry);
            }
            catch (Exception e)
            {
                Main.DebugLog(() => $"Failed to save migrated permissions: {e.GetType().Name}");
            }
        }

        const char EnDash = '\u2013';
        private string uncommittedPort = "initial";
        private string message = "";

        public void Draw()
        {
            GUILayout.BeginVertical(GUILayout.ExpandWidth(false));

            if (uncommittedPort == "initial")
                uncommittedPort = serverPort.ToString();

            GUILayout.Label($"Network port (1024{EnDash}65535)");
            uncommittedPort = GUILayout.TextField(uncommittedPort, maxLength: 5);
            uncommittedPort = new string(uncommittedPort.Where(c => char.IsDigit(c)).ToArray());
            bool isValidPort = int.TryParse(uncommittedPort, out var parsed) && parsed >= 1024 && parsed <= 65535;

            GUILayout.BeginHorizontal();
            GUILayout.Label(message);
            GUILayout.EndHorizontal();

            GUILayout.BeginHorizontal();
            GUILayout.Label("Password (blank for none)");
            serverPassword = GUILayout.TextField(serverPassword);
            GUILayout.EndHorizontal();

            permissions.Draw();

            var newShowUndiscoveredLocomotives = GUILayout.Toggle(
                showUndiscoveredLocomotives,
                "Show undiscovered locomotives");
            if (newShowUndiscoveredLocomotives != showUndiscoveredLocomotives)
            {
                showUndiscoveredLocomotives = newShowUndiscoveredLocomotives;
                CarUpdater.ForceCarRefresh();
            }

            enableLogging = GUILayout.Toggle(enableLogging, "Enable logging");

            GUILayout.EndVertical();
        }

        override public void Save(UnityModManager.ModEntry entry)
        {
            Save<Settings>(this, entry);
        }
    }

    public class Permissions
    {
        public class PlayerPermissions
        {
            public string name;
            public bool isAdministrator;
            public bool canToggleJunctions;
            // Legacy field kept only for one-time migration of existing UMM settings.
            public bool canControlLocomotives;

            public PlayerPermissions()
            {
                name = "";
            }

            public PlayerPermissions(string name)
            {
                this.name = name;
            }
        }

        public readonly List<PlayerPermissions> permissions = new List<PlayerPermissions>();

        private string lastPermissionSignature = "";

        public Permissions()
        {
            Sessions.OnSessionStarted += OnSessionStarted;
        }

        public void MigrateLegacyPermissions()
        {
            foreach (var permission in permissions)
            {
                if (permission.canControlLocomotives)
                    permission.isAdministrator = true;
                permission.canControlLocomotives = false;
            }
        }

        public bool HasJunctionPermission(string username)
        {
            return permissions.Find(p => p.name == username)?.canToggleJunctions ?? false;
        }

        public bool HasAdministratorPermission(string username)
        {
            return permissions.Find(p => p.name == username)?.isAdministrator ?? false;
        }

        /// <summary>Locomotive remote control is disabled; retained for source compatibility.</summary>
        public bool HasLocoControlPermission(string username)
        {
            return false;
        }

        private void OnSessionStarted(string username)
        {
            if (!permissions.Any(p => p.name == username))
            {
                permissions.Add(new PlayerPermissions(username));
                permissions.Sort((a, b) => StringComparer.OrdinalIgnoreCase.Compare(a.name, b.name));
            }
        }

        public void Draw()
        {
            GUILayout.Label("Dispatcher permissions:");
            GUILayout.BeginHorizontal("box", GUILayout.ExpandWidth(false));
            DrawNamesColumn();
            DrawConnectedColumn();
            DrawAdministratorColumn();
            DrawJunctionsColumn();
            GUILayout.EndHorizontal();

            var signature = string.Join(";", permissions.Select(p =>
                $"{p.name}:{(p.isAdministrator ? 1 : 0)}:{(p.canToggleJunctions ? 1 : 0)}"));
            if (signature != lastPermissionSignature)
            {
                lastPermissionSignature = signature;
                Sessions.AddTag("permissions");
            }
        }

        private void DrawColumn(string label, Action<PlayerPermissions> action)
        {
            GUILayout.BeginVertical();
            GUILayout.Label(label);
            foreach (var p in permissions)
                action(p);
            GUILayout.EndVertical();
        }

        private void DrawNamesColumn()
        {
            DrawColumn("Name", p => GUILayout.Label(p.name));
        }

        private void DrawConnectedColumn()
        {
            var connectedUsers = Sessions.GetUsersWithActiveSessions();
            DrawColumn("Connected", p => GUILayout.Toggle(connectedUsers.Contains(p.name), ""));
        }

        private void DrawAdministratorColumn()
        {
            DrawColumn("Administrator", p => p.isAdministrator = GUILayout.Toggle(p.isAdministrator, ""));
        }

        private void DrawJunctionsColumn()
        {
            DrawColumn("Junctions", p => p.canToggleJunctions = GUILayout.Toggle(p.canToggleJunctions, ""));
        }
    }
}
