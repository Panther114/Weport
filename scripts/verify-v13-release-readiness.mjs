// Bind the Windows candidate to inspected local receipts. Does not run/install/publish it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url), asar=require('@electron/asar')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const fileHash=file=>hash(fs.readFileSync(file))
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'))
const artifact='release/win-unpacked/resources/app.asar'
const version=json('package.json').version
assert.equal(version,'1.3.0')
assert.equal(JSON.parse(asar.extractFile(artifact,'package.json')).version,version)
const compiled=asar.listPackage(artifact).map(file=>file.replaceAll('\\','/').replace(/^\/+/,''))
  .filter(file=>/^(dist|dist-electron)\//.test(file)&&fs.existsSync(file)&&fs.statSync(file).isFile())
assert(compiled.length>20)
for(const file of compiled)assert.equal(hash(asar.extractFile(artifact,path.normalize(file))),fileHash(file),'Packaged compiled file differs: '+file)
const setup=`release/Weport-${version}-Setup.exe`, latest=fs.readFileSync('release/latest.yml','utf8')
assert(latest.startsWith(`version: ${version}`))
assert(latest.includes(`# Weport v${version}`)&&!/# Weport v1\.2/.test(latest))
const sha512=createHash('sha512').update(fs.readFileSync(setup)).digest('base64')
assert(latest.includes(sha512));assert(fs.existsSync(setup+'.blockmap'))
const native=json('.ui-probe/v13-readiness-native-exports.json')
assert(native.ok&&native.cleanup&&native.realProfileUnchanged&&native.exportSourceInputsUnchanged)
const verifyInputs=inputs=>{
  const entries=Object.entries(inputs);assert(entries.length>0)
  for(const [file,digest] of entries)assert.equal(fileHash(file),digest,'Evidence input changed: '+file)
  return {files:entries.length,digest:hash(JSON.stringify(inputs)),current:true}
}
const nativeInputs=verifyInputs(native.exportSourceInputs)
const nativeAssets=Object.entries(native.artifactHashes).filter(([file])=>!/app\.asar$|Weport\.exe$/i.test(file))
for(const [file,digest] of nativeAssets)assert.equal(fileHash(file),digest)
const exports=native.exports.results
assert.equal(exports.length,2);assert.equal(exports[0].messages,exports[1].messages)
assert.equal(exports[0].identityDigest,exports[1].identityDigest)
assert(exports.every(item=>item.jsonContentMatchesBaseline&&item.txtBytesMatchBaseline))
const aiReceipts=['.ui-probe/v13-groundedness.json','.ui-probe/v13-general-analysis.json'].map(file=>{
  const receipt=json(file);assert(receipt.ok&&receipt.realProfileUnchanged&&receipt.privateCleanupVerified&&receipt.sourceInputsUnchanged)
  assert.equal(receipt.windowsCreated,0);assert.equal(receipt.windowsRemaining,0)
  assert(receipt.checks.every(check=>check.passed))
  return {file,sha256:fileHash(file),inputs:verifyInputs(receipt.sourceInputs),cases:receipt.completedCases,
    providerRequests:receipt.providerRequests,provider:receipt.provider,
    strategy:receipt.checks.map(check=>({language:check.language,passed:check.passed,
      historyReads:check.strategy?.historyReads,contiguousReads:check.strategy?.contiguousReads,
      keywordSearches:check.strategy?.keywordSearches,sessions:check.strategy?.sessionsRead?.length}))}
})
const captures=json('docs/screenshots/current-capture.json')
assert(captures.hidden&&captures.syntheticOnly&&captures.noEngine)
assert.equal(captures.rendererHtmlSha256,fileHash('dist/index.html'))
for(const capture of captures.captures){assert(!capture.visible&&capture.stddev>=12);assert.equal(capture.sha256,fileHash(`docs/screenshots/${capture.tab}.png`))}
const images=[...fs.readFileSync('README.md','utf8').matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match=>match[1])
assert(images.length>10)
assert(images.every(file=>captures.readmeImages.includes(file)))
assert(['reader-export','reader-draft','reader-narrow','settings-light','search-semantic'].every(tab=>captures.captures.some(capture=>capture.tab===tab)))
const rendered=json('.ui-probe/readme-current/receipt.json');assert.equal(rendered.errors.length,0);assert.equal(rendered.missing.length,0)
const bench=json('.ui-probe/bench-last.json')
assert.equal(bench.measurementMode,'hidden-offscreen-compositor');assert.equal(bench.appAsarSha256,fileHash(artifact))
assert(bench.start.fcpMs>0&&bench.pages.every(page=>page.frames>5))
assert(bench.glass.frames.backdropFrames>0&&bench.glass.backdropLayers>0)
const cli=json('.ui-probe/v13-readiness-cli/results.json'),mcp=json('.ui-probe/v13-readiness-mcp/results.json')
assert(cli.cases.every(check=>check.ok));assert(mcp.cases.every(check=>check.ok))
assert(mcp.cases.some(check=>check.detail?.windows?.every(window=>!window.visible)&&check.detail?.focused===false))
const unitLog=fs.existsSync('.ui-probe/controls-unit.log')?'.ui-probe/controls-unit.log':'.ui-probe/v13-readiness-unit.log'
const units=fs.readFileSync(unitLog,'utf8'),unitCounts=units.match(/Tests\s+(\d+) passed\s+\|\s+(\d+) skipped/),unitFiles=units.match(/Test Files\s+(\d+) passed/)
assert(unitCounts&&unitFiles&&Number(unitCounts[1])>=2001&&Number(unitCounts[2])===8&&/pass 36/.test(units)&&/fail 0/.test(units))
const typecheck=fs.readFileSync(fs.existsSync('.ui-probe/controls-typecheck.log')?'.ui-probe/controls-typecheck.log':'.ui-probe/v13-readiness-typecheck.log','utf8');assert(typecheck.includes('tsc --noEmit')&&!/error TS\d+/.test(typecheck))
assert(fs.readFileSync(fs.existsSync('.ui-probe/controls-packaged-native.log')?'.ui-probe/controls-packaged-native.log':'.ui-probe/v13-readiness-packaged-native.log','utf8').includes('[packaged-native] PASS'))
const tui=fs.readFileSync('.ui-probe/v13-readiness-tui.log','utf8');assert(!/^FAIL /m.test(tui));assert((tui.match(/^PASS /gm)||[]).length>=30)
const issues=json('.ui-probe/v13-readiness-github-issues-pages.json').flat().filter(issue=>!issue.pull_request)
const result={checkedAt:new Date().toISOString(),version,scope:'Local Windows candidate with app-wide UI refinements; refined build not installed or published (preceding V1.3 installed with authorization)' ,
  artifact:{asarSha256:fileHash(artifact),compiledFilesVerified:compiled.length,installer:setup,installerBytes:fs.statSync(setup).size,installerSha256:fileHash(setup),installerSha512:sha512,latestYmlSha256:fileHash('release/latest.yml')},
  checks:{typecheck:true,unit:{files:Number(unitFiles[1]),passed:Number(unitCounts[1]),skipped:Number(unitCounts[2]),log:unitLog},nodeFixtures:36,packagedNativeInitialization:true,
    cliProtocol:cli.cases.length,mcpHttp:mcp.cases.length,tuiFrameChecks:(tui.match(/^PASS /gm)||[]).length,
    rendered:{captures:rendered.captures.length,controlStates:rendered.controlAudits?.length,readmeImages:images.length,checks:rendered.checks,errors:0,unhandledFixtureChannels:0},
    performance:{measurementMode:bench.measurementMode,baselineCompared:bench.baselineCompared,start:bench.start,idleCpu:bench.processes.idleAvgCpuPercent,glassP95Ms:bench.glass.frames.p95Delta}},
  realExport:{receiptSha256:fileHash('.ui-probe/v13-readiness-native-exports.json'),packageAsarAtRun:native.artifactHashes['release\\win-unpacked\\resources\\app.asar'],currentExportInputs:nativeInputs,nativeAssetsUnchanged:true,
    sessions:exports[0].sessions,messages:exports[0].messages,jsonAndTxtMatch:true,media:exports[0].media.map(({tier,opened,exportedExactBytes,failureKind})=>({tier,opened,exportedExactBytes,failureKind})),privateCleanup:true,realProfileUnchanged:true,
    qualification:'Full history exercise used the preceding ASAR and separately bundled production services. All export inputs and native assets still match; final packaged host initialization passed. Later ASAR changes include hidden-probe rendering, privacy wording and app-wide UI placement/refinement; the real-history export inputs and native assets still match.'},
  ai:aiReceipts,semantic:{fixtureSha256:json('.ui-probe/v13-semantic-symmetric/result.json').fixtureSha256,baselineRecallAt5:16/24,chatPrefixRecallAt5:19/24,queries:24,remainingMisses:5,defaultEnabled:false},
  github:{issues:issues.length,open:issues.filter(issue=>issue.state==='open').length,latest:json('.ui-probe/v13-readiness-github-release.json').tag_name,modified:false},
  limits:['No genuine second-account acceptance','Other WeChat versions and native Mac/Linux runtime coverage deferred','Production no-login scan gate remains disabled','Bounded image checks do not establish exhaustive media/key/codec recovery','Semantic quality measured on a tiny synthetic fixture','Hidden compositor smoke has no historical performance baseline','Local installer was built but not installed or published'],
  ok:true}
fs.writeFileSync('docs/v1.3-release-readiness.json',JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify({ok:true,version,unitTests:result.checks.unit.passed,images:images.length,messages:result.realExport.messages,installer:setup}))
