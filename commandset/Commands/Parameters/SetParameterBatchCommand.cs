// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Parameters
{
    public class SetParameterBatchCommand : ExternalEventCommandBase
    {
        private static readonly object _executionLock = new object();
        private SetParameterBatchEventHandler _handler => (SetParameterBatchEventHandler)Handler;

        public override string CommandName => "set_parameter_batch";

        public SetParameterBatchCommand(UIApplication uiApp)
            : base(new SetParameterBatchEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_executionLock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(120000))
                    throw new TimeoutException("set_parameter_batch timed out");
                return _handler.GetResultOrThrow();
            }
        }
    }
}
