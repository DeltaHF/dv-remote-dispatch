using System;
using System.IO;
using Newtonsoft.Json.Linq;

namespace DvMod.RemoteDispatch
{
    public static class WebConfig
    {
        public const string ConfigFileName = "webconfig.json";

        public static string GetConfigJson()
        {
            try
            {
                if (Main.mod != null)
                {
                    var path = Path.Combine(Main.mod.Path, ConfigFileName);
                    if (File.Exists(path))
                    {
                        var text = File.ReadAllText(path);
                        JToken.Parse(text);
                        return text;
                    }
                }
            }
            catch (Exception e)
            {
                Main.DebugLog(() => $"Failed to read {ConfigFileName}: {e}");
            }
            return "{}";
        }
    }
}
