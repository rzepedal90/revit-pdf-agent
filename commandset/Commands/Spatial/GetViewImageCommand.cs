// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Spatial
{
    public class GetViewImageCommand : ExternalEventCommandBase
    {
        private GetViewImageEventHandler _handler => (GetViewImageEventHandler)Handler;

        public override string CommandName => "get_view_image";

        public GetViewImageCommand(UIApplication uiApp)
            : base(new GetViewImageEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            long? viewId = null;
            if (parameters?["viewId"] != null && parameters["viewId"].Type != JTokenType.Null)
                viewId = parameters["viewId"].Value<long>();

            int pixelSize = 2000;
            if (parameters?["pixelSize"] != null && parameters["pixelSize"].Type != JTokenType.Null)
                pixelSize = parameters["pixelSize"].Value<int>();
            pixelSize = Math.Max(64, Math.Min(8000, pixelSize));

            double[] cropMm = null;
            var crop = parameters?["cropMm"] as JObject;
            if (crop != null)
            {
                cropMm = new[]
                {
                    crop["minX"].Value<double>(), crop["minY"].Value<double>(),
                    crop["maxX"].Value<double>(), crop["maxY"].Value<double>(),
                };
                if (cropMm[2] <= cropMm[0] || cropMm[3] <= cropMm[1])
                    throw new ArgumentException("cropMm must satisfy maxX > minX and maxY > minY.");
            }

            _handler.SetParameters(viewId, pixelSize, cropMm);
            if (RaiseAndWaitForCompletion(90000))
            {
                if (_handler.Error != null) throw new Exception(_handler.Error);
                return _handler.Result;
            }
            throw new TimeoutException("get_view_image timed out");
        }
    }
}
