import { analyzeSource } from './ast.mjs';
import { EXTENSIONS, isObject, safeRelative } from './util.mjs';
import path from 'node:path';

/** Check declarative examples with the same syntax engine; never execute code. */
export function evaluateRuleExamples(rule) {
  if (rule.examples === undefined || (Array.isArray(rule.examples) && !rule.examples.length)) {
    return { status:'NOT_PROVIDED', authority:'STATIC_SYNTAX_ONLY', cases:[], checked:0 };
  }
  if (!Array.isArray(rule.examples) || !rule.examples.some(item => isObject(item) && ('code' in item || 'expect' in item))) {
    return { status:'UNVERIFIED_LEGACY', authority:'NONE', cases:[], checked:0, note:'Legacy example data is retained but has no executable expectation.' };
  }
  if (rule.examples.length > 50) return {status:'INVALID_EXAMPLES',authority:'NONE',cases:[],checked:0,error:'At most 50 structured examples are supported.'};
  const cases = rule.examples.map((item,index) => {
    const base={index,description:typeof item?.description==='string'?item.description:undefined};
    try {
      if (!isObject(item) || typeof item.code!=='string' || Buffer.byteLength(item.code,'utf8')>32768 || !['valid','violation'].includes(item.expect)) {
        return {...base,status:'INVALID',error:'Use {code, expect: valid|violation, filename?, description?}; code is bounded to 32 KiB.'};
      }
      const filename=safeRelative(item.filename??'example.ts');
      if (!EXTENSIONS.has(path.extname(filename).toLowerCase()) || /\.d\.(?:ts|mts|cts)$/.test(filename)) return {...base,status:'INVALID',error:'Example filename must be a supported JS/TS source.'};
      if (rule.check.kind==='manual') return {...base,filename,expect:item.expect,status:'UNVERIFIED_MANUAL',code:item.code};
      const analysis=analyzeSource(item.code,filename,[rule]);
      if (analysis.parseErrors.length) return {...base,filename,expect:item.expect,status:'INCOMPLETE',parseErrors:analysis.parseErrors,code:item.code};
      const findings=analysis.findings.filter(finding=>finding.ruleId===rule.id);
      const pass=item.expect==='valid'?findings.length===0:findings.length>0;
      return {...base,filename,expect:item.expect,status:pass?'PASS':'FAIL',findings:findings.length,code:item.code};
    } catch(error) {return {...base,status:'INVALID',error:error.message};}
  });
  const status=cases.some(c=>c.status==='INVALID')?'INVALID_EXAMPLES':cases.some(c=>c.status==='INCOMPLETE')?'INCOMPLETE':cases.some(c=>c.status==='FAIL')?'FAIL':cases.some(c=>c.status==='UNVERIFIED_MANUAL')?'UNVERIFIED_MANUAL':'PASS';
  return {status,authority:'STATIC_SYNTAX_ONLY',cases,checked:cases.filter(c=>['PASS','FAIL'].includes(c.status)).length,
    note:'Examples test this checker in isolation. File applicability and project policy are resolved separately; no code is executed.'};
}
