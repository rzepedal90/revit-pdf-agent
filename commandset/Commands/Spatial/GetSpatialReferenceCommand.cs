// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Spatial
{
    public class GetSpatialReferenceCommand : ExternalEventCommandBase
    {
        private GetSpatialReferenceEventHandler _handler => (GetSpatialReferenceEventHandler)Handler;

        public override string CommandName => "get_spatial_reference";

        public GetSpatialReferenceCommand(UIApplication uiApp)
            : base(new GetSpatialReferenceEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            var idsArray = parameters?["ids"] as JArray;
            if (idsArray == null || idsArray.Count < 1 || idsArray.Count > 200)
                throw new ArgumentException("Parameter 'ids' must contain between 1 and 200 ElementIds.");

            var ids = new List<long>();
            foreach (var t in idsArray) ids.Add(t.Value<long>());
            long? viewId = parameters["viewId"] != null && parameters["viewId"].Type != JTokenType.Null
                ? parameters["viewId"].Value<long>()
                : (long?)null;

            _handler.SetParameters(ids, viewId);
            if (RaiseAndWaitForCompletion(30000))
            {
                if (_handler.Error != null) throw new Exception(_handler.Error);
                return _handler.Result;
            }
            throw new TimeoutException("get_spatial_reference timed out");
        }
    }
}
