using System;
using DV.Localization;
using I2.Loc;
using Newtonsoft.Json.Linq;

namespace DvMod.RemoteDispatch
{
    public static class StationData
    {
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
                stations[info.YardID] = new JObject(
                    new JProperty("name", ResolveName(info, language)),
                    new JProperty("position", new World.Position(moved.x, moved.z).ToLatLon().ToJson()));
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
    }
}
