// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// See THIRD_PARTY_NOTICES.md at the repository root for the full license text.
/** Fail-closed evidence checks. Contact is BIM geometry QA, not structural design. */
export function requireMaterial(actualId,expectedId,evidence) {
 if(!Number.isInteger(actualId)||!Number.isInteger(expectedId)||actualId!==expectedId||!evidence)
  throw Error('Missing or mismatched material evidence');
}
export function verifyBeamEndpoints({ends,supports,toleranceMm,allowedUnsupportedEnds=[]}) {
 if(ends?.length!==2||!Number.isFinite(toleranceMm)||toleranceMm<0)throw Error('Two endpoints and approved tolerance required');
 const finite=p=>p&&['x','y','z'].every(k=>Number.isFinite(p[k]));
 for(const support of supports)if(!support.uniqueId||!finite(support.min)||!finite(support.max)||
  ['x','y','z'].some(k=>support.min[k]>support.max[k]))throw Error('Incomplete support geometry');
 return ends.map((end,index)=>{
  if(!finite(end.pointMm)||end.nativeJoinEnabled!==true)throw Error('Missing endpoint geometry/native join evidence');
  // Bounding box is a broad-phase candidate only; a verified narrow-phase
  // solid-contact result is mandatory for concave, rotated or trimmed supports.
  const candidates=supports.filter(s=>['x','y','z'].every(k=>end.pointMm[k]>=s.min[k]-toleranceMm&&end.pointMm[k]<=s.max[k]+toleranceMm));
  const contacts=candidates.filter(s=>end.verifiedContactUniqueIds?.includes(s.uniqueId));
  if(!contacts.length&&!allowedUnsupportedEnds.includes(index))throw Error(`Unsupported beam endpoint ${index}; contact evidence required`);
  return {index,supportUniqueIds:contacts.map(s=>s.uniqueId),approvedException:!contacts.length};
 });
}
export function validatePlacementProfile(profile,{familyFingerprint,mcpVersion}) {
 if(profile?.verified!==true||profile.familyFingerprint!==familyFingerprint||profile.mcpVersion!==mcpVersion||
  !['level_offset','absolute_elevation'].includes(profile.zSemantics)||!profile.insertionPlane||
  !Array.isArray(profile.explicitInstanceParameters)||!profile.explicitInstanceParameters.length||
  !profile.fixtureEvidence||!profile.materialEvidence)throw Error('Missing/stale verified placement profile');
 return profile;
}
