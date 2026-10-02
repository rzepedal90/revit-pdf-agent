// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Utils;

namespace RevitMCPCommandSet.Services
{
    /// <summary>set_parameter_batch: many id-based writes in one transaction, all-or-nothing, verified by readback.</summary>
    public class SetParameterBatchEventHandler : TypedCommandHandlerBase
    {
        public override string GetName() => "set_parameter_batch";

        private sealed class Item
        {
            public int Index;
            public long ElementId;
            public string Name, BuiltIn, Label;
            public Element Owner;
            public PlannedWrite Plan;
        }

        protected override JObject Run(Document doc, JObject p)
        {
            var items = ParamUtil.Arr(p, "items");
            if (items.Count == 0)
                throw new RevitCommandException(ErrorCodes.InvalidParameter, "Parameter 'items' must not be empty.");
            var expected = ParamUtil.IntOrNull(p, "expectedCount");
            if (expected.HasValue) ExpectedCountPolicy.Validate(items.Count, expected.Value);

            var defUnits = ParamUtil.StrOrNull(p, "units");
            var defScope = ParamUtil.StrOrNull(p, "scope") ?? "instance";

            // Phase 1: resolve + coerce everything before touching the model.
            var planned = new List<Item>();
            var errors = new List<(string code, string msg)>();
            for (int i = 0; i < items.Count; i++)
            {
                var o = items[i] as JObject;
                try
                {
                    if (o == null)
                        throw new RevitCommandException(ErrorCodes.InvalidParameter, "items[" + i + "] must be an object.");
                    var it = new Item
                    {
                        Index = i,
                        ElementId = ParamUtil.Long(o, "elementId"),
                        Name = ParamUtil.StrOrNull(o, "name"),
                        BuiltIn = ParamUtil.StrOrNull(o, "builtIn"),
                    };
                    it.Label = !string.IsNullOrWhiteSpace(it.BuiltIn) ? it.BuiltIn : it.Name;
                    it.Owner = ParameterWriter.ResolveOwner(doc, it.ElementId, ParamUtil.StrOrNull(o, "scope") ?? defScope);
                    var param = ParameterWriter.Lookup(it.Owner, it.Name, it.BuiltIn);
                    it.Plan = ParameterWriter.Plan(param, it.Label, ParamUtil.Any(o, "value"), ParamUtil.StrOrNull(o, "units") ?? defUnits);
                    planned.Add(it);
                }
                catch (RevitCommandException ex)
                {
                    errors.Add((ex.Code, "item " + i + ": " + ex.Detail));
                }
            }
            Throw(errors, "no writes performed");

            // Phase 2: apply all, regenerate once, verify all; any failure rolls everything back.
            return InTransaction(doc, "Set parameters (batch)", () =>
            {
                foreach (var it in planned)
                {
                    try { ParameterWriter.Apply(it.Plan); }
                    catch (RevitCommandException ex) { errors.Add((ex.Code, "item " + it.Index + ": " + ex.Detail)); }
                }
                Throw(errors, "all changes rolled back");

                doc.Regenerate();

                var results = new JArray();
                foreach (var it in planned)
                {
                    try
                    {
                        var after = ParameterWriter.Verify(it.Owner, it.Name, it.BuiltIn, it.Plan);
                        results.Add(new JObject
                        {
                            ["index"] = it.Index,
                            ["elementId"] = it.ElementId,
                            ["name"] = it.Label,
                            ["before"] = it.Plan.Before,
                            ["after"] = after,
                        });
                    }
                    catch (RevitCommandException ex) { errors.Add((ex.Code, "item " + it.Index + ": " + ex.Detail)); }
                }
                Throw(errors, "all changes rolled back");

                return new JObject { ["ok"] = true, ["count"] = results.Count, ["items"] = results };
            });
        }

        private static void Throw(List<(string code, string msg)> errors, string suffix)
        {
            if (errors.Count == 0) return;
            var shown = errors.Take(10).Select(e => e.msg).ToList();
            var more = errors.Count > 10 ? " (+" + (errors.Count - 10) + " more)" : "";
            throw new RevitCommandException(errors[0].code,
                errors.Count + " item(s) failed, " + suffix + ": " + string.Join(" | ", shown) + more);
        }
    }
}
