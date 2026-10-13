#!/usr/bin/env bun
// Development-only oracle capture from the frozen TS/v2.8.1 and Bun runtime.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('..', import.meta.url).pathname;
const texts = ['', 'a', 'ab', 'aaab', 'abc', 'abb', 'ABC', 'A\nb', '\r\n', '阿米娅',
  '阿米娅。', '罗德岛', 'ſ', 'S', 'K', 'k', 'İ', 'ı', 'ß', 'σ', 'ς', 'Σ', '𠮷',
  '😀', '😀a', 'a😀b', 'a\u0000b', '２０００', '123', 'a\uFEFFb', 'a\u0085b', 'é',
  'e\u0301', 'PRTS_BENCH_NO_MATCH_7f814e', 'prts_bench_no_match_7f814e', 'PRTſ_BENCH_NO_MATCH_7f814e'];
const patterns = ['[a-zA-Z]', '[s-s]', '\\p{Lowercase_Letter}', '\\P{Lowercase_Letter}', '\\p{Uppercase_Letter}', '\\P{Uppercase_Letter}', '\\p{Ll}', '\\P{Ll}', '\\p{Lu}', '\\P{Lu}', '\\p{ASCII}', '', 'a', 'ab', 'a?', 'a*', 'a+', 'ab?', 'ab*', 'ab+', 'ab{0,2}', 'ab{1,2}',
  'a|b', '(?:a|b)c', 'a(?:b|c)', '(a)b', '(?:ab)', 'ab(?=c)', 'ab(?!c)', '(?<=a+)b',
  '(?<!a+)b', '(?<=a|aa)b', '(a)(b)?\\2', '(a)?\\1b', '(?<x>a)\\k<x>', '(a|b)\\1',
  '^a', 'a$', '^.$', '^..$', '.', '[a-z]', '[^a]', '\\d', '\\D', '\\w', '\\W', '\\s',
  '\\S', '\\bS\\b', '\\p{Script=Han}', '\\p{Letter}', '\\P{ASCII}', '\\u{1f600}',
  '\\uD83D\\uDE00', '\\uD800', '\\uDC00', '\\0', 'a\u0000b', '\\x61b', '\\u0061b',
  '阿米娅', '罗德岛', '阿米娅(?=。)', '阿(?:米|娅)', '阿米?娅', '(阿)米娅', '阿[米娅]',
  '阿米娅|罗德岛', '阿米娅?', 'ſ', 'S', 'K', 'K', 'σ', 'Σ', 'ß', 'i', '(?i:a)',
  '(?-i:a)', '(?s:.)', '(?m:^a)', '(?i)abc', '(?>a)', 'a++', '[', '(', '\\q', '\\8',
  '\\p{NotAProperty}', 'PRTS_BENCH_NO_MATCH_7f814e'];
const regex = [];
for (const pattern of patterns) for (const text of texts) {
  let match = null, rejected = false;
  try { match = new RegExp(pattern, 'iu').test(text); } catch { rejected = true; }
  regex.push({pattern, text, rejected, match});
}
const sourcePath = `${root}/.reference/ts-v2.8.1/ts/src/api/prtsWiki.ts`;
const source = readFileSync(sourcePath, 'utf8');
// Locate the function's closing brace explicitly, avoiding adjacent comments.
const htmlSource = source.slice(source.indexOf('function stripHtml'));
const selected = source.slice(source.indexOf('const CSS_JS_RE'), source.indexOf('async function resolveRedirectTitle')) +
  htmlSource.slice(0, htmlSource.indexOf('\n}')+2);
const js = new Bun.Transpiler({loader:'ts'}).transformSync(selected);
const names = ['unescapeHTMLEntities','cleanSnippet','stripHtml','isTechnicalPage','isRedirectLike'];
const helpers = Function(js+`\nreturn {${names.join(',')}};`)();
const inputs = [...texts, '<> <<x>文</x>', '<p>😀&#20013;&lt;b&gt;</p>',
  '<STYLE>x\ny</STYLE>保留<script>evil()</script>尾', '@media (x){body{a:b}}尾',
  '(window.RLQ || []).push(function(){});after', '\uFEFF \u0085中文\u0085 \uFEFF',
  '"k": "v", 正文', '|参数=😀\n正文', '#REDIRECT [[x]] #REDIRECT [[y]]',
  '&#38;#x41; &amp;lt; &AMP; &unknown;', '&#xD83D;&#xDE00;', '&#55357;&#56832;',
  '&#1114112;', '&#x110000;', '&#999999999999999999999999999999999;',
  '&#0000000000000000000000000000000000000065;', '&#65 &#xFF; &#X4e2d;',
  '&nbsp;&mdash;&quot;&apos;&shy;', 'Module:x', '模块:x', 'a/Spine/x', 'a/datax', 'x.JSON',
  '&constructor;', '&toString;&toLocaleString;&valueOf;', '&hasOwnProperty;&isPrototypeOf;&propertyIsEnumerable;', '#\uFEFF重定向 [[x]]', ', ,\n😀 ,', 'a\n\n\nb'];
const wiki = [];
for (const helper of names) for (const input of inputs) {
  try { wiki.push({helper,input,output:helpers[helper](input),rejected:false}); }
  catch { wiki.push({helper,input,rejected:true}); }
}
const out = {oracle:`bun ${Bun.version}`,source:'TS/v2.8.1',wiki_source_sha256:createHash('sha256').update(source).digest('hex'),flags:'iu',regex,wiki};
writeFileSync(`${root}/contracts/cases/golden/native-text-oracle.json`,JSON.stringify(out,null,2)+'\n');
console.log(`native oracle: ${regex.length} regex + ${wiki.length} Wiki cases`);
