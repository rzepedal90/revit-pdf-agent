// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.BuildElements;
using RevitMCPCommandSet.Utils;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.BuildElements
{
    public class BuildElementsCommand : ExternalEventCommandBase
    {
        private static readonly object _executionLock = new object();
        private BuildElementsEventHandler _handler => (BuildElementsEventHandler)Handler;

        public override string CommandName => "build_elements";

        public BuildElementsCommand(UIApplication uiApp) : base(new BuildElementsEventHandler(), uiApp) { }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_executionLock)
            {
                _handler.SetParameters(parameters ?? new JObject());
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("build_elements timed out");
                var err = _handler.Error;
                if (err is RevitCommandException) throw err;           // "[code] message"
                if (err != null) throw new RevitCommandException(ErrorCodes.RevitError, err.Message);
                return _handler.ResultInfo;
            }
        }
    }
}
