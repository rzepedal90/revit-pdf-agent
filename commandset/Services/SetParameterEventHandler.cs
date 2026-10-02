// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Utils;

namespace RevitMCPCommandSet.Services
{
    /// <summary>set_parameter: write one parameter, regenerate, read back, roll back on mismatch.</summary>
    public class SetParameterEventHandler : TypedCommandHandlerBase
    {
        public override string GetName() => "set_parameter";

        protected override JObject Run(Document doc, JObject p)
        {
            var elementId = ParamUtil.Long(p, "elementId");
            var name = ParamUtil.StrOrNull(p, "name");
            var builtIn = ParamUtil.StrOrNull(p, "builtIn");
            var value = ParamUtil.Any(p, "value");
            var units = ParamUtil.StrOrNull(p, "units");
            var scope = ParamUtil.StrOrNull(p, "scope") ?? "instance";

            var owner = ParameterWriter.ResolveOwner(doc, elementId, scope);
            var param = ParameterWriter.Lookup(owner, name, builtIn);
            var label = !string.IsNullOrWhiteSpace(builtIn) ? builtIn : name;
            var plan = ParameterWriter.Plan(param, label, value, units);

            return InTransaction(doc, "Set parameter", () =>
            {
                ParameterWriter.Apply(plan);
                doc.Regenerate();
                var after = ParameterWriter.Verify(owner, name, builtIn, plan);
                return new JObject
                {
                    ["ok"] = true,
                    ["elementId"] = elementId,
                    ["ownerId"] = owner.Id.GetValue(),
                    ["scope"] = scope.ToLowerInvariant(),
                    ["name"] = label,
                    ["before"] = plan.Before,
                    ["after"] = after,
                };
            });
        }
    }
}
