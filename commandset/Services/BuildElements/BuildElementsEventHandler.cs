// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.ElementQuery;
using RevitMCPCommandSet.Utils;

namespace RevitMCPCommandSet.Services.BuildElements
{
    /// <summary>
    /// build_elements: deterministic, idempotent bulk builder. All vertical constraints are explicit.
    /// One TransactionGroup (rolled back for dry runs / errors, assimilated otherwise) containing one
    /// Transaction whose failures preprocessor COLLECTS warnings so a dry run can report commit-time warnings.
    /// </summary>
    public class BuildElementsEventHandler : ElementQueryHandlerBase
    {
        public override string GetName() => "build_elements";

        private sealed class Ctx
        {
            public BuildItemSpec S;
            public Element Existing;
            public ElementId TypeId = ElementId.InvalidElementId;
            public Level L1;     // footing/beam level, column/wall base level
            public Level LTop;   // column/wall top level
            public string Action;
            public long Id = -1;
            public bool Created;
        }

        private sealed class FailRec
        {
            public string Message;
            public string Severity;
            public List<long> Ids = new List<long>();
        }

        private sealed class CollectingPreprocessor : IFailuresPreprocessor
        {
            public readonly List<FailRec> Warnings = new List<FailRec>();
            public readonly List<FailRec> Errors = new List<FailRec>();

            public FailureProcessingResult PreprocessFailures(FailuresAccessor fa)
            {
                foreach (var m in fa.GetFailureMessages())
                {
                    var sev = m.GetSeverity();
                    if (sev == FailureSeverity.None) continue;
                    var rec = new FailRec { Message = m.GetDescriptionText(), Severity = sev.ToString() };
                    foreach (var id in m.GetFailingElementIds()) rec.Ids.Add(id.GetValue());
                    foreach (var id in m.GetAdditionalElementIds()) rec.Ids.Add(id.GetValue());
                    if (sev == FailureSeverity.Warning) Warnings.Add(rec);   // collected, NOT deleted
                    else Errors.Add(rec);
                }
                return Errors.Count > 0 ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
            }
        }

        // ---- per-run state ----
        private Document _doc;
        private BuildSpec _spec;
        private Dictionary<string, Level> _levels;
        private Dictionary<string, List<Element>> _keys;
        private readonly Dictionary<string, ElementId> _typeCache = new Dictionary<string, ElementId>();
        private readonly Dictionary<long, string> _idToKey = new Dictionary<long, string>();
        private readonly HashSet<long> _createdIds = new HashSet<long>();

        protected override JObject Run(Document doc, JObject p)
        {
            _doc = doc;
            _spec = BuildElementsModel.Parse(p);
            _typeCache.Clear();
            _idToKey.Clear();
            _createdIds.Clear();

            _levels = new Dictionary<string, Level>(StringComparer.Ordinal);
            foreach (var l in new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>())
                if (!_levels.ContainsKey(l.Name)) _levels[l.Name] = l;
            _keys = SourceKeyStore.ScanAll(doc);

            var ctxs = new List<Ctx>();
            var errors = new JArray();
            var pre = new CollectingPreprocessor();
            bool committed = false;

            using (var tg = new TransactionGroup(doc, "build_elements"))
            {
                tg.Start();
                try
                {
                    using (var tx = new Transaction(doc, "build_elements"))
                    {
                        tx.Start();
                        var opts = tx.GetFailureHandlingOptions();
                        opts.SetFailuresPreprocessor(pre);
                        opts.SetClearAfterRollback(true);
                        opts.SetDelayedMiniWarnings(true);
                        tx.SetFailureHandlingOptions(opts);

                        foreach (var item in _spec.Items)
                        {
                            var c = new Ctx { S = item };
                            ctxs.Add(c);
                            try { ProcessItem(c); }
                            catch (RevitCommandException ex) { errors.Add(Err(item.SourceKey, ex.Code, ex.Detail)); }
                            catch (Exception ex) { errors.Add(Err(item.SourceKey, ErrorCodes.RevitError, ex.Message)); }
                        }

                        if (errors.Count > 0)
                        {
                            if (tx.GetStatus() == TransactionStatus.Started) tx.RollBack();
                        }
                        else
                        {
                            doc.Regenerate();
                            var st = tx.Commit();
                            if (st != TransactionStatus.Committed)
                            {
                                if (pre.Errors.Count == 0)
                                    errors.Add(Err(null, ErrorCodes.RevitError, "Transaction did not commit (" + st + ")."));
                                foreach (var f in pre.Errors)
                                    foreach (var e in ErrorsFor(f)) errors.Add(e);
                            }
                        }
                    }

                    // Readback of the committed state (before assimilating the group).
                    if (errors.Count == 0)
                    {
                        foreach (var c in ctxs)
                        {
                            if (c.Action == "skipped" && c.Id < 0) continue;
                            var el = _doc.GetElement(ParameterWriter.MakeId(c.Id));
                            if (el == null)
                            {
                                errors.Add(Err(c.S.SourceKey, ErrorCodes.ReadbackMismatch, "Element " + c.Id + " no longer exists after commit."));
                                continue;
                            }
                            var mism = Compare(c, el);
                            if (!string.Equals(SourceKeyStore.Read(el), c.S.SourceKey, StringComparison.Ordinal))
                                mism.Add("source key not stamped");
                            if (mism.Count > 0)
                                errors.Add(Err(c.S.SourceKey, ErrorCodes.ReadbackMismatch, "Readback mismatch: " + string.Join("; ", mism) + "."));
                        }
                    }

                    if (_spec.DryRun || errors.Count > 0)
                    {
                        tg.RollBack();
                    }
                    else
                    {
                        tg.Assimilate();
                        committed = true;
                    }
                }
                finally
                {
                    if (tg.GetStatus() == TransactionStatus.Started) tg.RollBack();
                }
            }

            return BuildResult(ctxs, errors, pre, committed);
        }

        // ------------------------------------------------------------------ result

        private static JObject Err(string key, string code, string message) =>
            new JObject { ["sourceKey"] = key == null ? JValue.CreateNull() : new JValue(key), ["code"] = code, ["message"] = message };

        private IEnumerable<JObject> ErrorsFor(FailRec f)
        {
            var keys = f.Ids.Select(i => _idToKey.TryGetValue(i, out var k) ? k : null).Where(k => k != null).Distinct().ToList();
            if (keys.Count == 0) { yield return Err(null, ErrorCodes.RevitError, f.Message); yield break; }
            foreach (var k in keys) yield return Err(k, ErrorCodes.RevitError, f.Message);
        }

        private JObject BuildResult(List<Ctx> ctxs, JArray errors, CollectingPreprocessor pre, bool committed)
        {
            bool dry = _spec.DryRun;
            int created = 0, updated = 0, skipped = 0;
            var items = new JArray();
            foreach (var c in ctxs)
            {
                if (c.Action == null) continue; // failed before an action was decided
                if (c.Action == "created") created++;
                else if (c.Action == "updated") updated++;
                else skipped++;
                var o = new JObject { ["sourceKey"] = c.S.SourceKey, ["action"] = c.Action };
                if (committed && c.Id >= 0)
                {
                    var el = _doc.GetElement(ParameterWriter.MakeId(c.Id));
                    o["id"] = c.Id;
                    o["uniqueId"] = el?.UniqueId;
                }
                else
                {
                    o["id"] = JValue.CreateNull();
                    o["uniqueId"] = JValue.CreateNull();
                }
                items.Add(o);
            }

            var warnings = new JArray();
            var seen = new HashSet<string>();
            foreach (var w in pre.Warnings)
            {
                var keys = w.Ids.Select(i => _idToKey.TryGetValue(i, out var k) ? k : null).Where(k => k != null).Distinct().ToList();
                var ids = w.Ids.Distinct().Where(i => !dry || !_createdIds.Contains(i)).ToList();
                var sig = w.Message + "|" + string.Join(",", w.Ids.OrderBy(i => i));
                if (!seen.Add(sig)) continue;
                warnings.Add(new JObject
                {
                    ["message"] = w.Message,
                    ["severity"] = w.Severity,
                    ["elementIds"] = new JArray(ids),
                    ["sourceKeys"] = new JArray(keys),
                });
            }

            var res = new JObject
            {
                ["ok"] = errors.Count == 0,
                ["dryRun"] = dry,
                ["committed"] = committed,
                ["manifestHash"] = _spec.ManifestHash == null ? JValue.CreateNull() : new JValue(_spec.ManifestHash),
                ["counts"] = new JObject
                {
                    ["created"] = created,
                    ["updated"] = updated,
                    ["skipped"] = skipped,
                    ["failed"] = errors.Count,
                },
                ["items"] = items,
                ["warnings"] = warnings,
                ["errors"] = errors,
            };
            return res;
        }

        // ------------------------------------------------------------------ item processing

        private static string Cat(string kind)
        {
            switch (kind)
            {
                case "footing": return "OST_StructuralFoundation";
                case "column": return "OST_StructuralColumns";
                case "beam": return "OST_StructuralFraming";
                default: return null;
            }
        }

        private static BuiltInCategory CatOf(string kind)
        {
            switch (kind)
            {
                case "footing": return BuiltInCategory.OST_StructuralFoundation;
                case "column": return BuiltInCategory.OST_StructuralColumns;
                default: return BuiltInCategory.OST_StructuralFraming;
            }
        }

        private static bool IsKind(Element el, string kind)
        {
            switch (kind)
            {
                case "wall": return el is Wall;
                case "grid": return el is Grid;
                default:
                    return el is FamilyInstance && el.Category != null && el.Category.Id.GetValue() == (long)CatOf(kind);
            }
        }

        private Level LevelByName(string name)
        {
            if (_levels.TryGetValue(name, out var l)) return l;
            var m = _levels.Values.Where(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase)).ToList();
            if (m.Count == 1) return m[0];
            throw new RevitCommandException(ErrorCodes.NotFound, "Level '" + name + "' not found.");
        }

        private ElementId ResolveType(BuildItemSpec s)
        {
            var cacheKey = s.Kind + "|" + (s.TypeId?.ToString() ?? "") + "|" + s.FamilyName + "|" + s.TypeName;
            if (_typeCache.TryGetValue(cacheKey, out var cached)) return cached;
            ElementId result;
            if (s.Kind == "wall")
            {
                if (s.TypeId != null)
                {
                    var wt = _doc.GetElement(ParameterWriter.MakeId(s.TypeId.Value)) as WallType
                        ?? throw new RevitCommandException(ErrorCodes.NotFound, "typeId " + s.TypeId + " is not a WallType.");
                    result = wt.Id;
                }
                else
                {
                    var m = new FilteredElementCollector(_doc).OfClass(typeof(WallType)).Cast<WallType>()
                        .Where(t => t.Name == s.TypeName).ToList();
                    result = Single(m.Select(t => t.Id).ToList(), "WallType '" + s.TypeName + "'");
                }
            }
            else
            {
                var bic = CatOf(s.Kind);
                if (s.TypeId != null)
                {
                    var fs = _doc.GetElement(ParameterWriter.MakeId(s.TypeId.Value)) as FamilySymbol
                        ?? throw new RevitCommandException(ErrorCodes.NotFound, "typeId " + s.TypeId + " is not a family type.");
                    if (fs.Category == null || fs.Category.Id.GetValue() != (long)bic)
                        throw new RevitCommandException(ErrorCodes.InvalidParameter, "typeId " + s.TypeId + " is not in category " + Cat(s.Kind) + ".");
                    result = fs.Id;
                }
                else
                {
                    var m = new FilteredElementCollector(_doc).OfClass(typeof(FamilySymbol)).OfCategory(bic).Cast<FamilySymbol>()
                        .Where(t => t.Name == s.TypeName && (string.IsNullOrWhiteSpace(s.FamilyName) || t.FamilyName == s.FamilyName)).ToList();
                    result = Single(m.Select(t => t.Id).ToList(),
                        "type '" + (string.IsNullOrWhiteSpace(s.FamilyName) ? "" : s.FamilyName + " : ") + s.TypeName + "' in " + Cat(s.Kind));
                }
            }
            _typeCache[cacheKey] = result;
            return result;
        }

        private static ElementId Single(List<ElementId> ids, string what)
        {
            if (ids.Count == 0) throw new RevitCommandException(ErrorCodes.NotFound, what + " not found.");
            if (ids.Count > 1)
                throw new RevitCommandException(ErrorCodes.InvalidParameter,
                    what + " is ambiguous (" + ids.Count + " matches: " + string.Join(",", ids.Select(i => i.GetValue())) + "); pass 'familyName' or 'typeId'.");
            return ids[0];
        }

        private void ProcessItem(Ctx c)
        {
            var s = c.S;

            // identity
            if (_keys.TryGetValue(s.SourceKey, out var found))
            {
                if (found.Count > 1)
                    throw new RevitCommandException(ErrorCodes.IdentityConflict,
                        "Source key '" + s.SourceKey + "' is on " + found.Count + " elements (" + string.Join(",", found.Select(e => e.Id.GetValue())) + ").");
                c.Existing = found[0];
                if (!IsKind(c.Existing, s.Kind))
                    throw new RevitCommandException(ErrorCodes.IdentityConflict,
                        "Source key '" + s.SourceKey + "' belongs to element " + c.Existing.Id.GetValue() + " which is not a " + s.Kind + ".");
                if (_spec.Mode == "create_only")
                    throw new RevitCommandException(ErrorCodes.IdentityConflict,
                        "Source key '" + s.SourceKey + "' already exists (element " + c.Existing.Id.GetValue() + ") and mode is create_only.");
            }
            else if (s.Kind == "grid")
            {
                var byName = new FilteredElementCollector(_doc).OfClass(typeof(Grid)).Cast<Grid>().Where(g => g.Name == s.GridName).ToList();
                if (byName.Count > 0)
                {
                    var otherKey = SourceKeyStore.Read(byName[0]);
                    if (otherKey != null && otherKey != s.SourceKey)
                        throw new RevitCommandException(ErrorCodes.IdentityConflict,
                            "Grid '" + s.GridName + "' already carries source key '" + otherKey + "'.");
                    if (_spec.Mode == "create_only")
                        throw new RevitCommandException(ErrorCodes.IdentityConflict, "Grid '" + s.GridName + "' already exists and mode is create_only.");
                    c.Existing = byName[0];
                }
            }

            // resolve levels / type
            switch (s.Kind)
            {
                case "footing":
                case "beam":
                    c.L1 = LevelByName(s.Level);
                    break;
                case "column":
                    c.L1 = LevelByName(s.BaseLevel);
                    c.LTop = LevelByName(s.TopLevel);
                    break;
                case "wall":
                    c.L1 = LevelByName(s.BaseLevel);
                    if (s.TopLevel != null) c.LTop = LevelByName(s.TopLevel);
                    break;
            }
            if (s.Kind != "grid") c.TypeId = ResolveType(s);

            if (c.Existing == null)
            {
                var el = Create(c);
                c.Created = true;
                c.Action = "created";
                c.Id = el.Id.GetValue();
                _createdIds.Add(c.Id);
                ApplyParameters(el, s);
                SourceKeyStore.Write(el, s.SourceKey, _spec.ManifestHash);
                _idToKey[c.Id] = s.SourceKey;
                return;
            }

            var ex = c.Existing;
            c.Id = ex.Id.GetValue();
            _idToKey[c.Id] = s.SourceKey;
            var diffs = Compare(c, ex);
            if (diffs.Count == 0)
            {
                c.Action = "skipped";
                if ((SourceKeyStore.ReadManifestHash(ex) ?? "") != (_spec.ManifestHash ?? "") || SourceKeyStore.Read(ex) != s.SourceKey)
                    SourceKeyStore.Write(ex, s.SourceKey, _spec.ManifestHash);
                return;
            }

            var updated = Update(c, ex);
            c.Id = updated.Id.GetValue();
            _idToKey[c.Id] = s.SourceKey;
            ApplyParameters(updated, s);
            SourceKeyStore.Write(updated, s.SourceKey, _spec.ManifestHash);
            c.Action = "updated";
        }

        // ------------------------------------------------------------------ create

        private FamilySymbol Symbol(Ctx c)
        {
            var fs = (FamilySymbol)_doc.GetElement(c.TypeId);
            if (!fs.IsActive)
            {
                fs.Activate();
                _doc.Regenerate();
            }
            return fs;
        }

        private static XYZ P3(MmPoint p, double zFt) =>
            new XYZ(BuildElementsModel.MmToFt(p.X), BuildElementsModel.MmToFt(p.Y), zFt);

        private static Line Axis(XYZ p) => Line.CreateBound(new XYZ(p.X, p.Y, 0), new XYZ(p.X, p.Y, 1));

        private Element Create(Ctx c)
        {
            var s = c.S;
            var mmFt = (Func<double, double>)BuildElementsModel.MmToFt;
            switch (s.Kind)
            {
                case "footing":
                {
                    var pt = P3(s.Point, c.L1.Elevation + mmFt(s.OffsetMm));
                    var fi = _doc.Create.NewFamilyInstance(pt, Symbol(c), c.L1, StructuralType.Footing);
                    if (Math.Abs(s.RotationDeg) > 1e-9)
                        ElementTransformUtils.RotateElement(_doc, fi.Id, Axis(pt), s.RotationDeg * Math.PI / 180.0);
                    SetFootingConstraints(fi, c);
                    return fi;
                }
                case "column":
                {
                    var pt = P3(s.Point, c.L1.Elevation + mmFt(s.BaseOffsetMm));
                    var fi = _doc.Create.NewFamilyInstance(pt, Symbol(c), c.L1, StructuralType.Column);
                    if (Math.Abs(s.RotationDeg) > 1e-9)
                        ElementTransformUtils.RotateElement(_doc, fi.Id, Axis(pt), s.RotationDeg * Math.PI / 180.0);
                    SetColumnConstraints(fi, c);
                    return fi;
                }
                case "beam":
                {
                    var line = Line.CreateBound(P3(s.Start, c.L1.Elevation + mmFt(s.StartOffsetMm)), P3(s.End, c.L1.Elevation + mmFt(s.EndOffsetMm)));
                    var fi = _doc.Create.NewFamilyInstance(line, Symbol(c), c.L1, StructuralType.Beam);
                    SetBeamConstraints(fi, c);
                    return fi;
                }
                case "wall":
                {
                    var z = c.L1.Elevation;
                    var line = Line.CreateBound(P3(s.Start, z), P3(s.End, z));
                    var h = s.HeightMm.HasValue ? mmFt(s.HeightMm.Value) : 10.0;
                    var w = Wall.Create(_doc, line, c.TypeId, c.L1.Id, h, mmFt(s.BaseOffsetMm), false, s.Structural);
                    SetWallConstraints(w, c);
                    return w;
                }
                default:
                {
                    var g = Grid.Create(_doc, Line.CreateBound(P3(s.Start, 0), P3(s.End, 0)));
                    SetGridName(g, s.GridName);
                    return g;
                }
            }
        }

        // ------------------------------------------------------------------ update

        private Element Update(Ctx c, Element el)
        {
            var s = c.S;

            // type first (may recreate the element and change its id)
            if (s.Kind != "grid" && TypeIdOf(el) != c.TypeId.GetValue())
            {
                if (s.Kind != "wall") Symbol(c);
                var nid = el.ChangeTypeId(c.TypeId);
                if (nid == null || nid == ElementId.InvalidElementId)
                    throw new RevitCommandException(ErrorCodes.RevitError, "Revit refused to change the type of element " + el.Id.GetValue() + ".");
                el = _doc.GetElement(nid);
            }

            switch (s.Kind)
            {
                case "footing":
                case "column":
                {
                    var lp = (LocationPoint)el.Location;
                    var cur = lp.Point;
                    var want = P3(s.Point, cur.Z);
                    var d = new XYZ(want.X - cur.X, want.Y - cur.Y, 0);
                    if (d.GetLength() > 1e-9) ElementTransformUtils.MoveElement(_doc, el.Id, d);
                    var dRot = BuildElementsModel.NormalizeDeg(s.RotationDeg - lp.Rotation * 180.0 / Math.PI);
                    if (dRot > 180.0) dRot -= 360.0;
                    if (Math.Abs(dRot) > 1e-6)
                        ElementTransformUtils.RotateElement(_doc, el.Id, Axis(want), dRot * Math.PI / 180.0);
                    if (s.Kind == "footing") SetFootingConstraints((FamilyInstance)el, c);
                    else SetColumnConstraints((FamilyInstance)el, c);
                    break;
                }
                case "beam":
                {
                    var lc = (LocationCurve)el.Location;
                    var z0 = c.L1.Elevation + BuildElementsModel.MmToFt(s.StartOffsetMm);
                    var z1 = c.L1.Elevation + BuildElementsModel.MmToFt(s.EndOffsetMm);
                    lc.Curve = Line.CreateBound(P3(s.Start, z0), P3(s.End, z1));
                    SetBeamConstraints((FamilyInstance)el, c);
                    break;
                }
                case "wall":
                {
                    var w = (Wall)el;
                    var lc = (LocationCurve)w.Location;
                    var z = c.L1.Elevation;
                    lc.Curve = Line.CreateBound(P3(s.Start, z), P3(s.End, z));
                    SetWallConstraints(w, c);
                    break;
                }
                case "grid":
                {
                    var g = (Grid)el;
                    SetGridName(g, s.GridName);
                    var curve = g.Curve;
                    var zc = curve != null ? curve.GetEndPoint(0).Z : 0;
                    var line = Line.CreateBound(P3(s.Start, zc), P3(s.End, zc));
                    if (!CurveMatches(curve, s)) g.SetCurveInView(DatumExtentType.Model, PlanView(), line);
                    break;
                }
            }
            return el;
        }

        private View PlanView()
        {
            if (_doc.ActiveView is ViewPlan vp && !vp.IsTemplate) return vp;
            var v = new FilteredElementCollector(_doc).OfClass(typeof(ViewPlan)).Cast<ViewPlan>().FirstOrDefault(x => !x.IsTemplate);
            return v ?? throw new RevitCommandException(ErrorCodes.NotFound, "No plan view available to move a grid.");
        }

        private void SetGridName(Grid g, string name)
        {
            if (g.Name == name) return;
            var other = new FilteredElementCollector(_doc).OfClass(typeof(Grid)).Cast<Grid>().FirstOrDefault(x => x.Name == name && x.Id != g.Id);
            if (other != null)
                throw new RevitCommandException(ErrorCodes.NameCollision, "Grid name '" + name + "' is used by element " + other.Id.GetValue() + ".");
            g.Name = name;
        }

        // ------------------------------------------------------------------ constraints (explicit, no defaults)

        private static readonly BuiltInParameter[] LevelParams =
        {
            BuiltInParameter.FAMILY_LEVEL_PARAM,
            BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM,
            BuiltInParameter.INSTANCE_SCHEDULE_ONLY_LEVEL_PARAM,
            BuiltInParameter.SCHEDULE_LEVEL_PARAM,
        };

        private static Parameter Prm(Element el, BuiltInParameter bip) => el.get_Parameter(bip);

        private static Parameter Need(Element el, BuiltInParameter bip)
        {
            var p = el.get_Parameter(bip);
            if (p == null) throw new RevitCommandException(ErrorCodes.NotFound, "Element " + el.Id.GetValue() + " has no built-in parameter " + bip + ".");
            if (p.IsReadOnly) throw new RevitCommandException(ErrorCodes.RevitError, "Parameter " + bip + " is read-only on element " + el.Id.GetValue() + ".");
            return p;
        }

        private static void SetMm(Element el, BuiltInParameter bip, double mm)
        {
            var p = Need(el, bip);
            var ft = BuildElementsModel.MmToFt(mm);
            if (p.StorageType == StorageType.Double && Math.Abs(p.AsDouble() - ft) < 1e-9) return;
            if (!p.Set(ft)) throw new RevitCommandException(ErrorCodes.RevitError, "Revit rejected " + bip + " = " + mm + " mm.");
        }

        private static void SetId(Element el, BuiltInParameter bip, ElementId id)
        {
            var p = Need(el, bip);
            if (p.AsElementId() == id) return;
            if (!p.Set(id)) throw new RevitCommandException(ErrorCodes.RevitError, "Revit rejected " + bip + " = " + id.GetValue() + ".");
        }

        private static void SetInt(Element el, BuiltInParameter bip, int v)
        {
            var p = Need(el, bip);
            if (p.AsInteger() == v) return;
            if (!p.Set(v)) throw new RevitCommandException(ErrorCodes.RevitError, "Revit rejected " + bip + " = " + v + ".");
        }

        private static void SetInstanceLevel(Element el, Level lvl)
        {
            foreach (var bip in LevelParams)
            {
                var p = Prm(el, bip);
                if (p == null || p.IsReadOnly || p.StorageType != StorageType.ElementId) continue;
                if (p.AsElementId() == lvl.Id) return;
                if (p.Set(lvl.Id)) return;
            }
            if (el.LevelId == lvl.Id) return;
            throw new RevitCommandException(ErrorCodes.RevitError, "Could not set the level of element " + el.Id.GetValue() + " to '" + lvl.Name + "'.");
        }

        private static void SetFootingConstraints(FamilyInstance fi, Ctx c)
        {
            SetInstanceLevel(fi, c.L1);
            SetMm(fi, BuiltInParameter.INSTANCE_FREE_HOST_OFFSET_PARAM, c.S.OffsetMm);
        }

        private static void SetColumnConstraints(FamilyInstance fi, Ctx c)
        {
            SetId(fi, BuiltInParameter.FAMILY_BASE_LEVEL_PARAM, c.L1.Id);
            SetId(fi, BuiltInParameter.FAMILY_TOP_LEVEL_PARAM, c.LTop.Id);
            SetMm(fi, BuiltInParameter.FAMILY_BASE_LEVEL_OFFSET_PARAM, c.S.BaseOffsetMm);
            SetMm(fi, BuiltInParameter.FAMILY_TOP_LEVEL_OFFSET_PARAM, c.S.TopOffsetMm);
        }

        private static void SetBeamConstraints(FamilyInstance fi, Ctx c)
        {
            var s = c.S;
            SetInstanceLevel(fi, c.L1);
            SetBeamEndOffset(fi, 0, s.StartOffsetMm);
            SetBeamEndOffset(fi, 1, s.EndOffsetMm);
            SetInt(fi, BuiltInParameter.Z_JUSTIFICATION, BuildElementsModel.ZJustificationValue(s.ZJustification));
            // The Z offset value (justification offset) must not be inherited from a previous state.
            var zo = Prm(fi, BuiltInParameter.Z_OFFSET_VALUE);
            if (zo != null && !zo.IsReadOnly && Math.Abs(zo.AsDouble()) > 1e-9) zo.Set(0.0);
            if (s.StructuralUsage != null)
            {
                var up = Need(fi, BuiltInParameter.INSTANCE_STRUCT_USAGE_PARAM);
                var want = UsageEnum(s.StructuralUsage);
                if (fi.StructuralUsage != want && !up.Set((int)want))
                    throw new RevitCommandException(ErrorCodes.RevitError, "Revit rejected structuralUsage '" + s.StructuralUsage + "'.");
            }
        }

        private static StructuralInstanceUsage UsageEnum(string u)
        {
            switch (u)
            {
                case "girder": return StructuralInstanceUsage.Girder;
                case "joist": return StructuralInstanceUsage.Joist;
                default: return StructuralInstanceUsage.Other;
            }
        }

        // Start/End Level Offset: STRUCTURAL_BEAM_END0/END1_ELEVATION in every supported version (2020-2026);
        // fall back to the localised-independent lookup by built-in only (no name guessing).
        private static Parameter BeamEndParam(Element el, int end) =>
            Prm(el, end == 0 ? BuiltInParameter.STRUCTURAL_BEAM_END0_ELEVATION : BuiltInParameter.STRUCTURAL_BEAM_END1_ELEVATION);

        private static void SetBeamEndOffset(FamilyInstance fi, int end, double mm)
        {
            var p = BeamEndParam(fi, end);
            if (p == null || p.IsReadOnly)
                throw new RevitCommandException(ErrorCodes.NotFound, "Beam " + fi.Id.GetValue() + " has no writable " + (end == 0 ? "start" : "end") + " level offset parameter.");
            var ft = BuildElementsModel.MmToFt(mm);
            if (Math.Abs(p.AsDouble() - ft) < 1e-9) return;
            if (!p.Set(ft)) throw new RevitCommandException(ErrorCodes.RevitError, "Revit rejected beam " + (end == 0 ? "start" : "end") + " offset " + mm + " mm.");
        }

        private static void SetWallConstraints(Wall w, Ctx c)
        {
            var s = c.S;
            SetId(w, BuiltInParameter.WALL_BASE_CONSTRAINT, c.L1.Id);
            SetMm(w, BuiltInParameter.WALL_BASE_OFFSET, s.BaseOffsetMm);
            if (c.LTop != null)
            {
                SetId(w, BuiltInParameter.WALL_HEIGHT_TYPE, c.LTop.Id);
                SetMm(w, BuiltInParameter.WALL_TOP_OFFSET, s.TopOffsetMm);
            }
            else
            {
                SetId(w, BuiltInParameter.WALL_HEIGHT_TYPE, ElementId.InvalidElementId);
                SetMm(w, BuiltInParameter.WALL_USER_HEIGHT_PARAM, s.HeightMm.Value);
            }
            SetInt(w, BuiltInParameter.WALL_STRUCTURAL_SIGNIFICANT, s.Structural ? 1 : 0);
            SetInt(w, BuiltInParameter.WALL_KEY_REF_PARAM, BuildElementsModel.LocationLineValue(s.LocationLine));
        }

        // ------------------------------------------------------------------ instance parameters

        private static void ApplyParameters(Element el, BuildItemSpec s)
        {
            foreach (var ps in s.Parameters)
            {
                var prm = ParameterWriter.Lookup(el, ps.Name, ps.BuiltIn);
                var plan = ParameterWriter.Plan(prm, ps.BuiltIn ?? ps.Name, ps.Value, ps.Units);
                if (!ParameterWriter.Matches(plan)) ParameterWriter.Apply(plan);
            }
        }

        // ------------------------------------------------------------------ compare / readback

        private static long TypeIdOf(Element el) => el.GetTypeId().GetValue();

        private static double? Mm(Element el, BuiltInParameter bip)
        {
            var p = Prm(el, bip);
            return p == null || p.StorageType != StorageType.Double ? (double?)null : BuildElementsModel.FtToMm(p.AsDouble());
        }

        private static long? IdVal(Element el, BuiltInParameter bip)
        {
            var p = Prm(el, bip);
            return p == null || p.StorageType != StorageType.ElementId ? (long?)null : p.AsElementId().GetValue();
        }

        private static long InstanceLevelId(Element el)
        {
            foreach (var bip in LevelParams)
            {
                var p = Prm(el, bip);
                if (p == null || p.StorageType != StorageType.ElementId) continue;
                var id = p.AsElementId();
                if (id != null && id != ElementId.InvalidElementId) return id.GetValue();
            }
            return el.LevelId.GetValue();
        }

        private static void CheckMm(List<string> d, string what, double? actual, double expected)
        {
            if (actual == null) d.Add(what + ": parameter missing");
            else if (!BuildElementsModel.NearMm(actual.Value, expected))
                d.Add(what + " is " + actual.Value.ToString("0.###") + " mm, expected " + expected.ToString("0.###"));
        }

        private static void CheckId(List<string> d, string what, long? actual, long expected)
        {
            if (actual == null) d.Add(what + ": parameter missing");
            else if (actual.Value != expected) d.Add(what + " is element " + actual.Value + ", expected " + expected);
        }

        private static void CheckXY(List<string> d, string what, XYZ actualFt, MmPoint want)
        {
            var ax = BuildElementsModel.FtToMm(actualFt.X);
            var ay = BuildElementsModel.FtToMm(actualFt.Y);
            if (!BuildElementsModel.NearMm(ax, want.X) || !BuildElementsModel.NearMm(ay, want.Y))
                d.Add(what + " is (" + ax.ToString("0.###") + "," + ay.ToString("0.###") + ") mm, expected (" + want.X.ToString("0.###") + "," + want.Y.ToString("0.###") + ")");
        }

        private static bool CurveMatches(Curve curve, BuildItemSpec s)
        {
            if (curve == null || !curve.IsBound) return false;
            var l = new List<string>();
            CheckXY(l, "start", curve.GetEndPoint(0), s.Start);
            CheckXY(l, "end", curve.GetEndPoint(1), s.End);
            return l.Count == 0;
        }

        /// <summary>Everything that differs between the request and the live element (empty = identical).</summary>
        private List<string> Compare(Ctx c, Element el)
        {
            var s = c.S;
            var d = new List<string>();

            if (s.Kind != "grid" && TypeIdOf(el) != c.TypeId.GetValue())
                d.Add("type is " + TypeIdOf(el) + ", expected " + c.TypeId.GetValue());

            switch (s.Kind)
            {
                case "footing":
                case "column":
                {
                    if (!(el.Location is LocationPoint lp)) { d.Add("no point location"); break; }
                    CheckXY(d, "location", lp.Point, s.Point);
                    var rot = lp.Rotation * 180.0 / Math.PI;
                    if (BuildElementsModel.AngleDiffDeg(rot, s.RotationDeg) > BuildElementsModel.AngleToleranceDeg)
                        d.Add("rotation is " + BuildElementsModel.NormalizeDeg(rot).ToString("0.####") + " deg, expected " + s.RotationDeg.ToString("0.####"));
                    if (s.Kind == "footing")
                    {
                        CheckId(d, "level", InstanceLevelId(el), c.L1.Id.GetValue());
                        CheckMm(d, "offset", Mm(el, BuiltInParameter.INSTANCE_FREE_HOST_OFFSET_PARAM), s.OffsetMm);
                    }
                    else
                    {
                        CheckId(d, "base level", IdVal(el, BuiltInParameter.FAMILY_BASE_LEVEL_PARAM), c.L1.Id.GetValue());
                        CheckMm(d, "base offset", Mm(el, BuiltInParameter.FAMILY_BASE_LEVEL_OFFSET_PARAM), s.BaseOffsetMm);
                        CheckId(d, "top level", IdVal(el, BuiltInParameter.FAMILY_TOP_LEVEL_PARAM), c.LTop.Id.GetValue());
                        CheckMm(d, "top offset", Mm(el, BuiltInParameter.FAMILY_TOP_LEVEL_OFFSET_PARAM), s.TopOffsetMm);
                    }
                    break;
                }
                case "beam":
                {
                    if (!(el.Location is LocationCurve lc) || lc.Curve == null) { d.Add("no curve location"); break; }
                    CheckXY(d, "start", lc.Curve.GetEndPoint(0), s.Start);
                    CheckXY(d, "end", lc.Curve.GetEndPoint(1), s.End);
                    CheckId(d, "level", InstanceLevelId(el), c.L1.Id.GetValue());
                    var p0 = BeamEndParam(el, 0);
                    var p1 = BeamEndParam(el, 1);
                    CheckMm(d, "start offset", p0 == null ? (double?)null : BuildElementsModel.FtToMm(p0.AsDouble()), s.StartOffsetMm);
                    CheckMm(d, "end offset", p1 == null ? (double?)null : BuildElementsModel.FtToMm(p1.AsDouble()), s.EndOffsetMm);
                    var zj = Prm(el, BuiltInParameter.Z_JUSTIFICATION);
                    var wantZ = BuildElementsModel.ZJustificationValue(s.ZJustification);
                    if (zj == null) d.Add("z justification: parameter missing");
                    else if (zj.AsInteger() != wantZ) d.Add("z justification is " + zj.AsInteger() + ", expected " + wantZ + " (" + s.ZJustification + ")");
                    var zo = Prm(el, BuiltInParameter.Z_OFFSET_VALUE);
                    if (zo != null && Math.Abs(BuildElementsModel.FtToMm(zo.AsDouble())) > BuildElementsModel.MmTolerance)
                        d.Add("z offset value is " + BuildElementsModel.FtToMm(zo.AsDouble()).ToString("0.###") + " mm, expected 0");
                    if (s.StructuralUsage != null && el is FamilyInstance fi && fi.StructuralUsage != UsageEnum(s.StructuralUsage))
                        d.Add("structural usage is " + fi.StructuralUsage + ", expected " + s.StructuralUsage);
                    break;
                }
                case "wall":
                {
                    if (!(el.Location is LocationCurve lc) || lc.Curve == null) { d.Add("no curve location"); break; }
                    CheckXY(d, "start", lc.Curve.GetEndPoint(0), s.Start);
                    CheckXY(d, "end", lc.Curve.GetEndPoint(1), s.End);
                    CheckId(d, "base level", IdVal(el, BuiltInParameter.WALL_BASE_CONSTRAINT), c.L1.Id.GetValue());
                    CheckMm(d, "base offset", Mm(el, BuiltInParameter.WALL_BASE_OFFSET), s.BaseOffsetMm);
                    if (c.LTop != null)
                    {
                        CheckId(d, "top level", IdVal(el, BuiltInParameter.WALL_HEIGHT_TYPE), c.LTop.Id.GetValue());
                        CheckMm(d, "top offset", Mm(el, BuiltInParameter.WALL_TOP_OFFSET), s.TopOffsetMm);
                    }
                    else
                    {
                        CheckId(d, "top constraint", IdVal(el, BuiltInParameter.WALL_HEIGHT_TYPE), ElementId.InvalidElementId.GetValue());
                        CheckMm(d, "height", Mm(el, BuiltInParameter.WALL_USER_HEIGHT_PARAM), s.HeightMm.Value);
                    }
                    var st = Prm(el, BuiltInParameter.WALL_STRUCTURAL_SIGNIFICANT);
                    if (st == null || (st.AsInteger() != 0) != s.Structural) d.Add("structural flag differs");
                    var kr = Prm(el, BuiltInParameter.WALL_KEY_REF_PARAM);
                    var wantK = BuildElementsModel.LocationLineValue(s.LocationLine);
                    if (kr == null || kr.AsInteger() != wantK) d.Add("location line is " + (kr == null ? "missing" : kr.AsInteger().ToString()) + ", expected " + wantK + " (" + s.LocationLine + ")");
                    break;
                }
                case "grid":
                {
                    var g = (Grid)el;
                    if (g.Name != s.GridName) d.Add("name is '" + g.Name + "', expected '" + s.GridName + "'");
                    if (!CurveMatches(g.Curve, s)) d.Add("curve endpoints differ");
                    break;
                }
            }

            foreach (var ps in s.Parameters)
            {
                try
                {
                    var prm = ParameterWriter.Lookup(el, ps.Name, ps.BuiltIn);
                    var plan = ParameterWriter.Plan(prm, ps.BuiltIn ?? ps.Name, ps.Value, ps.Units);
                    if (!ParameterWriter.Matches(plan)) d.Add("parameter '" + (ps.BuiltIn ?? ps.Name) + "' differs");
                }
                catch (RevitCommandException ex) { d.Add("parameter '" + (ps.BuiltIn ?? ps.Name) + "': " + ex.Detail); }
            }
            return d;
        }
    }
}
