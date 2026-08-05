using System;
using System.Collections.Generic;
using DV.Localization;
using I2.Loc;
using Newtonsoft.Json.Linq;

namespace DvMod.RemoteDispatch_BT
{
    public static class StationData
    {
        private static readonly HashSet<string> MilitaryYardIds = new HashSet<string> { "MB", "HMB", "MFMB" };

        public static JObject GetStationData(string? language)
        {
            if (!WorldStreamingInit.Instance || !WorldStreamingInit.IsLoaded)
                throw new Exception("World not yet loaded");

            var stations = new JObject();
            foreach (var station in StationController.allStations)
            {
                var info = station.stationInfo;
                if (info == null)
                    continue;
                var moved = station.transform.position - WorldMover.currentMove;
                var stationJson = new JObject(
                    new JProperty("name", ResolveName(info, language)),
                    new JProperty("position", new World.Position(moved.x, moved.z).ToLatLon().ToJson()));
                if (MilitaryYardIds.Contains(info.YardID))
                    stationJson.Add(new JProperty("type", "military"));
                stations[info.YardID] = stationJson;
            }
            if (PassengerJobsIntegration.IsAvailable())
            {
                foreach (var (id, location) in PassengerJobsIntegration.GetRuralStations())
                {
                    if (stations.ContainsKey(id))
                        continue;
                    stations[id] = new JObject(
                        new JProperty("name", ResolveRuralName(id, language)),
                        new JProperty("position", new World.Position(location.x, location.z).ToLatLon().ToJson()),
                        new JProperty("type", "passenger"));
                }
            }
            return new JObject(
                new JProperty("languages", new JArray(LocalizationManager.GetAllLanguages())),
                new JProperty("stations", stations));
        }

        private static string ResolveName(StationInfo info, string? language)
        {
            try
            {
                var key = info.LocalizationKey;
                if (!string.IsNullOrEmpty(key) && LocalizationAPI.HasTranslation(key))
                {
                    var translated = string.IsNullOrEmpty(language)
                        ? LocalizationAPI.L(key)
                        : LocalizationAPI.Lo(key, language, null);
                    if (!string.IsNullOrEmpty(translated))
                        return translated;
                }
            }
            catch (Exception e)
            {
                Main.DebugLog(() => $"Failed to localize station {info.YardID}: {e}");
            }
            return info.Name;
        }

        private static string ResolveRuralName(string id, string? language)
        {
            try
            {
                var key = "passjobs/station_" + id.ToLowerInvariant();
                if (LocalizationAPI.HasTranslation(key))
                {
                    var translated = string.IsNullOrEmpty(language)
                        ? LocalizationAPI.L(key)
                        : LocalizationAPI.Lo(key, language, null);
                    if (!string.IsNullOrEmpty(translated))
                        return translated;
                }
            }
            catch (Exception e)
            {
                Main.DebugLog(() => $"Failed to localize rural station {id}: {e}");
            }
            var pjName = PassengerJobsIntegration.GetRuralStationName(id);
            if (!string.IsNullOrEmpty(pjName) && pjName != id)
                return pjName;
            return id;
        }
    }
}
