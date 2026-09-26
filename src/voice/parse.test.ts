import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchBranch, numberWordsToDigits, parseIntent, parseSpokenTicket } from './parse.js';

const opts = { defaultProject: 'AN', projects: ['AN', 'QA'] };

describe('parseSpokenTicket', () => {
  const cases: Array<[string, string, boolean]> = [
    ['arregla el ticket AN-1234', 'AN-1234', false],
    ['arregla el ticket an 1234', 'AN-1234', false],
    ['arregla el ticket A.N. 1234', 'AN-1234', false],
    ['arregla el a n 1234', 'AN-1234', false],
    ['arregla el ticket a ene 1.234', 'AN-1234', false],
    ['revisa el QA 77', 'QA-77', false],
    ['corrige el cu a 77', 'QA-77', false],
    ['arregla el 1234', 'AN-1234', true],
    ['arregla el ticket RB-29011', 'RB-29011', false],
    ['arregla el ticket RB29011', 'RB-29011', false],
    ['arregla el ticket rb 29011', 'RB-29011', false],
    ['arregla el ticket erre be 29011', 'RB-29011', false],
    ['arregla el ticket R.B. 29011', 'RB-29011', false],
    ['arregla a rb 29011', 'RB-29011', false],
    ['arregla a n29011', 'AN-29011', false],
    ['arregla el ticket dash 12', 'DASH-12', false],
    ['arregla XYZ-12', 'XYZ-12', false],
    ['arregla el ticket a ene mil doscientos treinta y cuatro', 'AN-1234', false],
    ['revisa el ticket an novecientos ochenta y siete', 'AN-987', false],
    ['arregla el ticket AN1234', 'AN-1234', false],
    ['Arregla el ticket an1234', 'AN-1234', false],
    ['arregla el ticket a n-1234', 'AN-1234', false],
    ['arregla el ticket an 1 2 3 4', 'AN-1234', false],
    ['corrige el ticket AN29173', 'AN-29173', false],
    ['Arregla el ticket N1234', 'AN-1234', true],
  ];
  for (const [text, key, assumed] of cases) {
    it(text, () => assert.deepEqual(parseSpokenTicket(text, opts), { key, assumedProject: assumed }));
  }
});

describe('parseIntent', () => {
  it('fix con rama y notas', () => {
    assert.deepEqual(parseIntent('Oye Dabot arregla el ticket AN 1234 desde develop, ten en cuenta el componente Datagrid', opts), {
      type: 'fix',
      ticket: { key: 'AN-1234', assumedProject: false },
      branch: 'develop',
      notes: 'el componente Datagrid',
    });
  });
  it('verbo "haz" y ticket sin verbo', () => {
    assert.equal(parseIntent('haz el ticket AN 1234', opts).type, 'fix');
    assert.equal(parseIntent('Dabot, el ticket AN1234 desde develop', opts).type, 'fix');
  });
  it('fix con rama deletreada', () => {
    const i = parseIntent('arregla el an 1234 desde la rama release barra 9 punto 5', opts);
    assert.equal(i.type === 'fix' && i.branch, 'release/9.5');
  });
  it('fix con "el bug está en"', () => {
    const i = parseIntent('revisa el AN 99: el bug está en el sort panel', opts);
    assert.equal(i.type === 'fix' && i.notes, 'el bug está en el sort panel');
  });
  const simple: Array<[string, string]> = [
    ['sí', 'yes'],
    ['sí, cambia el estado', 'yes'],
    ['dale', 'yes'],
    ['sube la rama y abre el PR', 'yes'],
    ['no', 'no'],
    ['déjalo así', 'no'],
    ['mejor no', 'no'],
    ['no te entendí', 'repeat'],
    ['¿cómo va?', 'status'],
    ['cómo va todo', 'status'],
    ['qué hay pendiente', 'status'],
    ['la dos', 'option'],
    ['opción 3', 'option'],
    ['el primero', 'option'],
    ['solo con código', 'code_only'],
    ['reintenta', 'retry'],
    ['descarta el ticket', 'discard'],
    ['nada', 'cancel'],
    ['', 'cancel'],
    ['el filtro se aplica dos veces', 'text'],
  ];
  for (const [text, type] of simple) {
    it(`"${text}" → ${type}`, () => assert.equal(parseIntent(text, opts).type, type));
  }
  it('mensaje para Claude conserva tildes', () => {
    assert.deepEqual(parseIntent('dile a Claude que también ajuste el test de la región', opts), {
      type: 'message',
      text: 'también ajuste el test de la región',
    });
  });
  it('la dos → índice 1', () => assert.deepEqual(parseIntent('la dos', opts), { type: 'option', index: 1 }));
});

describe('matchBranch', () => {
  const branches = ['develop', 'main', 'release/9.5', 'release/9.4', 'epic/new-grid'];
  it('exacta', () => assert.equal(matchBranch('develop', branches), 'develop'));
  it('deletreada', () => assert.equal(matchBranch('release barra 9 punto 5', branches), 'release/9.5'));
  it('con espacios', () => assert.equal(matchBranch('release 9.5', branches), 'release/9.5'));
  it('solo el último tramo', () => assert.equal(matchBranch('9.4', branches), 'release/9.4'));
  it('guion', () => assert.equal(matchBranch('epic barra new guion grid', branches), 'epic/new-grid'));
  it('sin coincidencia', () => assert.equal(matchBranch('feature x', branches), undefined));
});

describe('numberWordsToDigits', () => {
  const cases: Array<[string, string]> = [
    ['mil doscientos treinta y cuatro', '1234'],
    ['dos mil veinte', '2020'],
    ['novecientos ochenta y siete', '987'],
    ['el ticket cuarenta y dos ya', 'el ticket 42 ya'],
    ['la dos', 'la dos'],
    ['un momento', 'un momento'],
    ['cinco mil', '5000'],
  ];
  for (const [text, out] of cases) it(text, () => assert.equal(numberWordsToDigits(text), out));
});
