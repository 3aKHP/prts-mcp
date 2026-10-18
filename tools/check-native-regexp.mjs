#!/usr/bin/env node
// Developer-only memory-safety check of the C boundary with ASan + UBSan.
// End users consume the statically linked binaries, not this compiler script.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = new URL('..', import.meta.url).pathname;
const out = resolve(root, 'artifacts/native-performance/asan');
mkdirSync(out,{recursive:true});
const corpus = JSON.parse(readFileSync(resolve(root,'contracts/cases/golden/native-text-oracle.json'),'utf8')).regex;
const approved = JSON.parse(readFileSync(resolve(root,'contracts/cases/native-regex-differences.json'),'utf8')).cases;
const octal = text => [...Buffer.from(text)].map(b=>'\\'+b.toString(8).padStart(3,'0')).join('');
const declarations=[],tests=[];
for(const [n,c] of corpus.entries()) {
 const units=Array.from({length:c.text.length},(_,i)=>c.text.charCodeAt(i));
 declarations.push(`static const char p${n}[]="${octal(c.pattern)}";\nstatic const uint16_t t${n}[]={${units.length?units.join(','):'0'}};`);
 const exception=approved.find(d=>d.pattern===c.pattern&&d.text===c.text);
 tests.push(`check(p${n},sizeof(p${n})-1,t${n},${units.length},${+c.rejected},${+(exception?.rust_match??c.match)});`);
}
const code=`#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <assert.h>
uint8_t *prts_re_compile(const char*,size_t,int,int*,char*,int);
void prts_re_free(void*);
int prts_re_exec(const uint8_t*,const uint16_t*,int,int,int*,int*,int (*)(void*),void*);
int prts_re_prefix(const uint8_t*,int,uint32_t*,int,int*,int*);
${declarations.join('\n')}
static void check(const char *p,size_t n,const uint16_t *text,int size,int reject,int expected) {
 char error[256]={0}; int length=0;
 uint8_t *bc=prts_re_compile(p,n,18,&length,error,256);
 if ((bc==NULL)!=reject) fprintf(stderr,"compile mismatch: reject=%d error=%s pattern=%s\\n",reject,error,p);
 assert((bc==NULL)==reject);
 if(!bc) return;
 uint32_t prefix[32]; int fold=0,complete=0;
 int count=prts_re_prefix(bc,length,prefix,32,&fold,&complete);
 assert(count>=0&&count<=32);
 int from=-1,to=-1;
 int matched=prts_re_exec(bc,text,size,0,&from,&to,NULL,NULL);
 assert(matched==expected);
 if(matched) assert(from>=0&&to>=from&&to<=size);
 prts_re_free(bc);
}
int main(void) {
 ${tests.join('\n')}
 puts("NATIVE_ASAN_PASS: ${corpus.length} cases");
 return 0;
}
`;
const source=resolve(out,'harness.c'),binary=resolve(out,'harness');
writeFileSync(source,code);
execFileSync('cc',['-D_GNU_SOURCE','-std=c11','-O1','-g','-fsanitize=address,undefined',
 '-fno-omit-frame-pointer','-I',resolve(root,'vendor/quickjs-regexp'),source,
 resolve(root,'native/regexp.c'),resolve(root,'vendor/quickjs-regexp/libregexp.c'),
 resolve(root,'vendor/quickjs-regexp/libunicode.c'),'-o',binary],{stdio:'inherit'});
execFileSync(binary,[],{stdio:'inherit',env:{...process.env,ASAN_OPTIONS:'detect_leaks=1:halt_on_error=1',UBSAN_OPTIONS:'halt_on_error=1'}});
