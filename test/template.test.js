import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, escapeHtml } from '../src/template.js';

test('interpolation, dotted lookup and unknown keys', () => {
  assert.equal(render('{{a}}/{{b.c}}/{{missing}}', { a: 1, b: { c: 2 } }), '1/2/');
});

test('array sections repeat and expose the current item', () => {
  assert.equal(render('{{#xs}}[{{.}}]{{/xs}}', { xs: [1, 2, 3] }), '[1][2][3]');
  assert.equal(render('{{#xs}}{{k}}{{/xs}}', { xs: [{ k: 'a' }, { k: 'b' }] }), 'ab');
});

test('sections fall back to the enclosing scope', () => {
  assert.equal(render('{{#xs}}{{outer}}{{k}}{{/xs}}', { outer: '-', xs: [{ k: 'a' }] }), '-a');
});

test('truthy non-array sections render once, falsy ones not at all', () => {
  assert.equal(render('{{#f}}yes{{/f}}', { f: true }), 'yes');
  for (const v of [false, null, undefined, '', 0, []]) {
    assert.equal(render('{{#f}}yes{{/f}}', { f: v }), '', `for ${JSON.stringify(v)}`);
  }
});

test('inverted sections cover exactly the empty cases', () => {
  assert.equal(render('{{^f}}none{{/f}}', { f: [] }), 'none');
  assert.equal(render('{{^f}}none{{/f}}', { f: 'x' }), '');
});

test('sections nest', () => {
  assert.equal(render('{{#a}}A{{#b}}B{{/b}}{{/a}}', { a: true, b: true }), 'AB');
});

test('a section tag alone on a line takes the whole line with it', () => {
  assert.equal(render('one\n{{#s}}\ntwo\n{{/s}}\nthree', { s: true }), 'one\ntwo\nthree');
  assert.equal(render('one\n{{#s}}\ntwo\n{{/s}}\nthree', { s: false }), 'one\nthree');
});

test('escaping is opt-in and triple-stache always raw', () => {
  assert.equal(render('{{a}}', { a: '<b>' }), '<b>');
  assert.equal(render('{{a}}', { a: '<b>' }, { escape: escapeHtml }), '&lt;b&gt;');
  assert.equal(render('{{{a}}}', { a: '<b>' }, { escape: escapeHtml }), '<b>');
});
