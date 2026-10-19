const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Exercise the worker shipped in the single-file editor, without a browser or build step.
const html = fs.readFileSync(path.join(__dirname, '..', 'WebMeshEditor.html'), 'utf8');
const encoded = html.match(/var CARD_ENGINE_WORKER_SOURCE_B64 = "([^"]+)";/)[1];
const messages = [];
const worker = vm.createContext({
  self: { postMessage(message) { messages.push(message); } },
  TextEncoder, TextDecoder, performance, setTimeout, clearTimeout
});
vm.runInContext(Buffer.from(encoded, 'base64').toString('utf8'), worker);
const parse = vm.runInContext('parseDeckToCardStream', worker);
const session = vm.runInContext('getParseSession', worker);
const tokenize = vm.runInContext('tokenizeCardLines', worker);
const hydrate = vm.runInContext('getHydrationTokens', worker);
const write = vm.runInContext('handleWriteRequest', worker);
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'hexa8_default_x.bdf'), 'utf8');
const originalCard = 'CHEXA,1,1,1,2,3,4,5,6,+E0\n+E0,7,8';
const expected = ['CHEXA', '1', '1', '1', '2', '3', '4', '5', '6', '7', '8'];
const plain = value => JSON.parse(JSON.stringify(value));

for (const [name, card] of [
  ['labeled', originalCard],
  ['numeric label', originalCard.replaceAll('+E0', '+123')],
  ['bare marker', originalCard.replaceAll('+E0', '+')],
  ['implicit label', originalCard.replace(',+E0\n', '\n')],
  ['blank head', originalCard.replace(',+E0\n+E0', '\n')],
  ['indented blank head', originalCard.replace(',+E0\n+E0', '\n   ')],
  ['star label', originalCard.replaceAll('+E0', '*E0')],
  ['multiple continuations', 'CHEXA,1,1,1,2,3,4,+A\n+A,5,6,+B\n+B,7,8'],
]) {
  for (const retainParseSession of [false, true]) {
    for (const includeLineTokenMetadata of [false, true]) {
      test(`${name}: ${retainParseSession ? 'editable' : 'fast'} import, metadata=${includeLineTokenMetadata}`, async () => {
        const result = await parse(fixture.replace(originalCard, card), 'test.bdf', {}, {
          retainParseSession, extractSolidBoundary: true,
          retainRawLines: false, includeLineTokenMetadata
        });
        assert.deepEqual(plain(result.errors), []);
        assert.deepEqual(plain(result.warnings), []);
        assert.equal(result.model.summary.nodeCount, 8);
        assert.equal(result.model.summary.elementCount, 1);
        const core = result.transferables.coreModel;
        assert.deepEqual(Array.from(core.elemIds), [1]);
        // The transfer stores connectivity as indices into nodeIds.
        assert.deepEqual(Array.from(core.elemNodeIds, index => core.nodeIds[index]), [1, 2, 3, 4, 5, 6, 7, 8]);
        assert.equal(result.surfaces.solidBoundaryFaces.length / 6, 6);
        if (retainParseSession) {
          const rec = session(result.model.parseSessionId).cardStream.find(c => c.name === 'CHEXA');
          assert.deepEqual(plain(rec.tokens), expected);
        }
      });
    }
  }

  test(`${name}: tokenizer and legacy hydration agree`, () => {
    const tokenized = tokenize('free', card.split('\n'));
    assert.deepEqual(plain(tokenized.tokens), expected);
    assert.deepEqual(plain(hydrate({ name: 'CHEXA', fmt: 'free', lineTokens: tokenized.lineTokens })), expected);
  });
}

test('signed numeric data and interior blank fields survive', async () => {
  for (const number of ['+8', '+1E3', '+1.0-3']) {
    const line = `GRID,1,,0.,0.,${number}`;
    assert.deepEqual(plain(tokenize('free', [line]).tokens), ['GRID', '1', '', '0.', '0.', number]);
    const result = await parse(`BEGIN BULK\n${line}\nENDDATA`, 'signed.bdf', {}, {});
    assert.deepEqual(plain(result.errors), []);
    assert.deepEqual(plain(result.warnings), []);
    assert.equal(result.transferables.coreModel.nodePosGlobal[2], number === '+8' ? 8 : number === '+1E3' ? 1000 : 0.001);
  }
});

for (const writeFormat of ['source', 'free', 'small', 'large']) {
  test(`export/reimport in ${writeFormat} format preserves the CHEXA`, async () => {
    const parsed = await parse(fixture, 'test.bdf', {}, { retainParseSession: true });
    messages.length = 0;
    write({ model: parsed.model, options: { writeFormat } });
    const output = messages.find(message => message.type === 'WRITE_COMPLETE');
    assert.ok(output, 'worker must produce an exported deck');
    const reparsed = await parse(output.text, 'roundtrip.bdf', {}, { extractSolidBoundary: true });
    assert.deepEqual(plain(reparsed.errors), []);
    assert.deepEqual(plain(reparsed.warnings), []);
    const core = reparsed.transferables.coreModel;
    assert.equal(core.counts.nodes, 8);
    assert.equal(core.counts.elements, 1);
    assert.deepEqual(Array.from(core.elemNodeIds, index => core.nodeIds[index]), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(reparsed.surfaces.solidBoundaryFaces.length / 6, 6);
  });
}
