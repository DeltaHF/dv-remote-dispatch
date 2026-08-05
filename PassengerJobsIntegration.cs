using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using UnityEngine;

namespace DvMod.RemoteDispatch_BT
{
    public static class PassengerJobsIntegration
    {
        private static bool? available;

        public static bool IsAvailable()
        {
            if (available == null)
            {
                try
                {
                    available = UnityModManagerNet.UnityModManager.FindMod("PassengerJobs")?.Assembly != null;
                }
                catch (Exception e)
                {
                    Main.DebugLog(() => $"PassengerJobs not available: {e.GetType().Name}");
                    available = false;
                }
            }
            return available.Value;
        }

        public static List<(string id, Vector3 location)> GetRuralStations()
        {
            var result = new List<(string id, Vector3 location)>();
            if (!IsAvailable())
                return result;
            try
            {
                CollectRuralStations(result);
            }
            catch (Exception e)
            {
                Main.DebugLog(() => $"Failed to collect PassengerJobs rural stations: {e}");
            }
            return result;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void CollectRuralStations(List<(string id, Vector3 location)> result)
        {
            var ruralStations = PassengerJobs.Generation.RouteManager.RuralStations;
            if (ruralStations == null)
                return;
            foreach (var station in ruralStations)
            {
                if (station == null || string.IsNullOrEmpty(station.id))
                    continue;
                result.Add((station.id, station.location));
            }
        }

        public static string? GetRuralStationName(string id)
        {
            if (!IsAvailable())
                return null;
            try
            {
                return GetRuralStationNameInternal(id);
            }
            catch (Exception e)
            {
                Main.DebugLog(() => $"Failed to get PassengerJobs station name for {id}: {e}");
                return null;
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static string? GetRuralStationNameInternal(string id)
        {
            return PassengerJobs.LocalizationKeyExtensions.StationName(id);
        }
    }
}
