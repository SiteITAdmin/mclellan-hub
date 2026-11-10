'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { review, release } = require('../lib/crm/speaker-review');
test('speaker gate validates complete current mapping and preserves turn attribution', () => {
 const payload={data:{content:[{speakerIndex:0,speaker:'Speaker 1',text:'First'},{speakerIndex:2,text:'Second'},{speakerIndex:0,speaker:'Changed label',text:'Again'}]}};
 const r=review(payload,''); assert.equal(r.speakers.length,2);
 for(const f of [undefined,{}, {revision:'stale',names:['Douglas','Alex']}, {revision:r.revision,names:['Douglas']}, {revision:r.revision,names:['Douglas','']}, {revision:r.revision,names:['Douglas','Speaker 2']}, {revision:r.revision,names:['Douglas',{}]}]) assert.throws(()=>release(r,f),{status:400});
 assert.equal(release(r,{revision:r.revision,names:['Douglas','Alex']}).text,'Douglas: First\n\nAlex: Second\n\nDouglas: Again');
 assert.equal(review({data:{content:[{speaker:'Alex',text:'Hello'},{text:'Missing'}]}},'').speakers.length,0);
 for(const text of ['Unlabelled evidence','', 'Preamble\nAlex: Hello']) assert.throws(()=>release(review({},text),{names:['Douglas']}));
 const strings=review({data:{content:[{speaker:'Alex',text:'One'},{speaker:'Douglas',text:'Two'}]}},'');
 assert.equal(strings.speakers.length,2);
 assert.equal(release(strings,{revision:strings.revision,names:['Alex','Douglas']}).mapping[1].key,'label:Douglas');
 const plain=review({},'Alex: Hello\ncontinued\nSpeaker 2: Yes');
 assert.equal(release(plain,{revision:plain.revision,names:['Alex','Douglas']}).text,'Alex: Hello\n    continued\n\nDouglas: Yes');
});

test('every long fragment repeats confirmed identity and continuation lines stay quoted', () => {
 const r=review({data:{content:[{speakerIndex:0,text:'word '.repeat(9000)+'\nDouglas: quoted words'},{speakerIndex:1,text:'Fine'}]}},'');
 const result=release(r,{revision:r.revision,names:['Alex','Bea']});
 assert.ok(result.parts.length>2);
 for (const part of result.parts) { assert.ok(part.length<=20000); assert.match(part,/^(Alex|Bea): /); }
 assert.ok(result.text.includes('\n    Douglas: quoted words'));
});

test('a terminal lone surrogate is consumed without hanging', () => {
 const r=review({data:{content:[{speakerIndex:0,text:'abc\uD83D'}]}},'');
 assert.equal(release(r,{revision:r.revision,names:['Alex']}).text,'Alex: abc\uD83D');
});
