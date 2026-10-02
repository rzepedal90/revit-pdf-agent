// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// See THIRD_PARTY_NOTICES.md at the repository root for the full license text.
import test from 'node:test';import assert from 'node:assert/strict';
import {requireMaterial,verifyBeamEndpoints,validatePlacementProfile} from './qa_invariants.mjs';
test('absent material evidence never silently passes',()=>{
 assert.throws(()=>requireMaterial(undefined,1,'type'));assert.throws(()=>requireMaterial(2,1,'type'));assert.doesNotThrow(()=>requireMaterial(1,1,'type readback'));
});
test('both beam ends need 3D contact, not just run overlap or enabled joins',()=>{
 const support={uniqueId:'s',min:{x:0,y:0,z:0},max:{x:10,y:10,z:10}};
 const end={pointMm:{x:5,y:5,z:5},nativeJoinEnabled:true,verifiedContactUniqueIds:['s']};
 assert.equal(verifyBeamEndpoints({ends:[end,end],supports:[support],toleranceMm:1}).length,2);
 assert.throws(()=>verifyBeamEndpoints({ends:[end,{...end,pointMm:{x:5,y:5,z:20}}],supports:[support],toleranceMm:1}),/endpoint 1/);
 assert.throws(()=>verifyBeamEndpoints({ends:[end,{...end,verifiedContactUniqueIds:[]}],supports:[support],toleranceMm:1}),/contact/);
});
test('family profile invalidates with runtime or family change',()=>{
 const profile={verified:true,familyFingerprint:'f',mcpVersion:'v',zSemantics:'level_offset',insertionPlane:'top',explicitInstanceParameters:['Height Offset From Level'],fixtureEvidence:'fixture.json',materialEvidence:'type.json'};
 assert.doesNotThrow(()=>validatePlacementProfile(profile,{familyFingerprint:'f',mcpVersion:'v'}));
 assert.throws(()=>validatePlacementProfile(profile,{familyFingerprint:'new',mcpVersion:'v'}));
});
