import { describe, expect, test } from "bun:test";
import { clipboardCell, parseClipboard } from "./clipboard";

describe("clipboardCell", () => {
  test("a copied cell pastes back as one cell", () => {
    for (const text of ["plain", "two\nlines", 'say "hi"', "a\tb", '5" screen']) {
      expect(parseClipboard(clipboardCell(text))).toEqual([[text]]);
    }
    expect(clipboardCell("plain")).toBe("plain");
    // An empty cell copies as nothing, which pastes as nothing.
    expect(parseClipboard(clipboardCell(""))).toEqual([]);
  });
});

describe("parseClipboard", () => {
  test("tab-separated cells, one line per row", () => {
    expect(parseClipboard("Acme\tAnn Lee\nGlobex\tBo Chan")).toEqual([
      ["Acme", "Ann Lee"],
      ["Globex", "Bo Chan"],
    ]);
  });

  test("the line break after the last row only ends the block", () => {
    expect(parseClipboard("Acme\tAnn Lee\nGlobex\tBo Chan\n")).toEqual([
      ["Acme", "Ann Lee"],
      ["Globex", "Bo Chan"],
    ]);
    expect(parseClipboard("Acme\n")).toEqual([["Acme"]]);
  });

  test("Windows line breaks (CRLF), with and without the trailing one", () => {
    expect(parseClipboard("a\tb\r\nc\td\r\n")).toEqual([["a", "b"], ["c", "d"]]);
    expect(parseClipboard("a\tb\r\nc\td")).toEqual([["a", "b"], ["c", "d"]]);
    expect(parseClipboard("a\rb\r")).toEqual([["a"], ["b"]]);
  });

  test("a quoted cell keeps its line breaks: it is one cell, not extra rows", () => {
    expect(parseClipboard('"Line one\nLine two"\tAcme\r\nNext\tGlobex\r\n')).toEqual([
      ["Line one\nLine two", "Acme"],
      ["Next", "Globex"],
    ]);
    // Excel's in-cell break copied as CRLF is stored as \n like any other.
    expect(parseClipboard('"one\r\ntwo"\r\n')).toEqual([["one\ntwo"]]);
    // A quoted cell last in its row, and in the block.
    expect(parseClipboard('x\t"a\nb\nc"')).toEqual([["x", "a\nb\nc"]]);
  });

  test("doubled quotes inside a quoted cell are one quote", () => {
    expect(parseClipboard('"She said ""hi""\nthen left"\tb\n')).toEqual([['She said "hi"\nthen left', "b"]]);
    expect(parseClipboard('"""Quoted"""\n')).toEqual([['"Quoted"']]);
    expect(parseClipboard('""""')).toEqual([['"']]);
    expect(parseClipboard('""\tx')).toEqual([["", "x"]]);
  });

  test("a quoted cell may hold a tab", () => {
    expect(parseClipboard('"a\tb"\tc\n')).toEqual([["a\tb", "c"]]);
  });

  test("quotes in an unquoted cell are kept as they are", () => {
    expect(parseClipboard('5" screen\tx\n')).toEqual([['5" screen', "x"]]);
    expect(parseClipboard('"Quoted" text\tx\n')).toEqual([['"Quoted" text', "x"]]);
    expect(parseClipboard('"never closed\tx\ny\n')).toEqual([['"never closed', "x"], ["y"]]);
  });

  test("empty cells and empty rows are kept, so the block keeps its shape", () => {
    expect(parseClipboard("a\t\tc\n")).toEqual([["a", "", "c"]]);
    expect(parseClipboard("a\t\n")).toEqual([["a", ""]]);
    expect(parseClipboard("a\n\nb\n")).toEqual([["a"], [""], ["b"]]);
    // One empty cell copied from Excel: pasting it clears the cell.
    expect(parseClipboard("\r\n")).toEqual([[""]]);
    expect(parseClipboard("")).toEqual([]);
  });
});
