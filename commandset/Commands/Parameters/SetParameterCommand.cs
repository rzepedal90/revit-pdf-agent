// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Parameters
{
    public class SetParameterCommand : ExternalEventCommandBase
    {
        private static readonly object _executionLock = new object();
        private SetParameterEventHandler _handler => (SetParameterEventHandler)Handler;

        public override string CommandName => "set_parameter";

        public SetParameterCommand(UIApplication uiApp)
            : base(new SetParameterEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_executionLock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(60000))
                    throw new TimeoutException("set_parameter timed out");
                // Throws RevitCommandException ("[code] message") on typed failure.
                return _handler.GetResultOrThrow();
            }
        }
    }
}
