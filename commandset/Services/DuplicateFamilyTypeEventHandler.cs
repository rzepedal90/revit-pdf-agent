// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Utils;

namespace RevitMCPCommandSet.Services
{
    /// <summary>duplicate_family_type: duplicate a type under a new name, set type parameters, read each back.</summary>
    public class DuplicateFamilyTypeEventHandler : TypedCommandHandlerBase
    {
        public override string GetName() => "duplicate_family_type";

        private static List<ElementType> FindTypes(Document doc, string familyName, string typeName)
        {
            return new FilteredElementCollector(doc)
                .WhereElementIsElementType()
                .OfType<ElementType>()
                .Where(t => t.FamilyName == familyName && t.Name == typeName)
                .ToList();
        }

        private sealed class Spec
        {
            public string Name, BuiltIn, Label, Units;
            public JToken Value;
        }

        protected override JObject Run(Document doc, JObject p)
        {
            var newName = ParamUtil.Str(p, "newName");
            if (string.IsNullOrWhiteSpace(newName))
                throw new RevitCommandException(ErrorCodes.InvalidParameter, "Parameter 'newName' must not be empty.");
            var reuse = ParamUtil.BoolOr(p, "reuseIfIdentical", false);

            var specs = new List<Spec>();
            var arr = ParamUtil.ArrOrNull(p, "parameters");
            if (arr != null)
            {
                for (int i = 0; i < arr.Count; i++)
                {
                    var o = arr[i] as JObject
                        ?? throw new RevitCommandException(ErrorCodes.InvalidParameter, "parameters[" + i + "] must be an object.");
                    var s = new Spec
                    {
                        Name = ParamUtil.StrOrNull(o, "name"),
                        BuiltIn = ParamUtil.StrOrNull(o, "builtIn"),
                        Units = ParamUtil.StrOrNull(o, "units"),
                        Value = ParamUtil.Any(o, "value"),
                    };
                    s.Label = !string.IsNullOrWhiteSpace(s.BuiltIn) ? s.BuiltIn : s.Name;
                    if (string.IsNullOrWhiteSpace(s.Label))
                        throw new RevitCommandException(ErrorCodes.InvalidParameter, "parameters[" + i + "] needs 'name' or 'builtIn'.");
                    specs.Add(s);
                }
            }

            // Resolve source type.
            ElementType source;
            var srcId = ParamUtil.LongOrNull(p, "sourceTypeId");
            if (srcId.HasValue)
            {
                source = doc.GetElement(ParameterWriter.MakeId(srcId.Value)) as ElementType
                    ?? throw new RevitCommandException(ErrorCodes.NotFound, "Element " + srcId.Value + " is not a type element.");
            }
            else
            {
                var fam = ParamUtil.StrOrNull(p, "familyName");
                var typ = ParamUtil.StrOrNull(p, "typeName");
                if (fam == null || typ == null)
                    throw new RevitCommandException(ErrorCodes.InvalidParameter, "Provide 'sourceTypeId' or both 'familyName' and 'typeName'.");
                var matches = FindTypes(doc, fam, typ);
                if (matches.Count == 0)
                    throw new RevitCommandException(ErrorCodes.NotFound, "No type '" + typ + "' in family '" + fam + "'.");
                ExpectedCountPolicy.Validate(matches.Count, 1);
                source = matches[0];
            }

            // Name collision within the source's family.
            var existing = FindTypes(doc, source.FamilyName, newName)
                .Where(t => t.Category == null || source.Category == null || t.Category.Id == source.Category.Id)
                .FirstOrDefault();
            if (existing != null)
            {
                if (reuse && specs.All(s => AlreadyMatches(existing, s)))
                {
                    var read = new JArray();
                    foreach (var s in specs)
                    {
                        var prm = ParameterWriter.Lookup(existing, s.Name, s.BuiltIn);
                        read.Add(new JObject { ["name"] = s.Label, ["after"] = ParameterWriter.Snapshot(prm) });
                    }
                    return Result(existing, false, true, read);
                }
                throw new RevitCommandException(ErrorCodes.NameCollision,
                    "A type named '" + newName + "' already exists in family '" + source.FamilyName + "' (id " + existing.Id.GetValue() + ")." +
                    (reuse ? " reuseIfIdentical was set but the given parameters differ." : ""));
            }

            return InTransaction(doc, "Duplicate family type", () =>
            {
                var dup = source.Duplicate(newName) as ElementType
                    ?? throw new RevitCommandException(ErrorCodes.RevitError, "Duplicate did not return a type element.");

                var plans = new List<(Spec spec, PlannedWrite plan)>();
                foreach (var s in specs)
                {
                    var prm = ParameterWriter.Lookup(dup, s.Name, s.BuiltIn);
                    plans.Add((s, ParameterWriter.Plan(prm, s.Label, s.Value, s.Units)));
                }
                foreach (var pl in plans) ParameterWriter.Apply(pl.plan);
                doc.Regenerate();

                var read = new JArray();
                foreach (var pl in plans)
                {
                    var after = ParameterWriter.Verify(dup, pl.spec.Name, pl.spec.BuiltIn, pl.plan);
                    read.Add(new JObject { ["name"] = pl.spec.Label, ["before"] = pl.plan.Before, ["after"] = after });
                }
                return Result(dup, true, false, read);
            });
        }

        private static bool AlreadyMatches(ElementType type, Spec s)
        {
            var prm = ParameterWriter.Lookup(type, s.Name, s.BuiltIn);
            return ParameterWriter.Matches(ParameterWriter.Plan(prm, s.Label, s.Value, s.Units));
        }

        private static JObject Result(ElementType t, bool created, bool reused, JArray readback) => new JObject
        {
            ["ok"] = true,
            ["typeId"] = t.Id.GetValue(),
            ["name"] = t.Name,
            ["familyName"] = t.FamilyName,
            ["created"] = created,
            ["reused"] = reused,
            ["readback"] = readback,
        };
    }
}
