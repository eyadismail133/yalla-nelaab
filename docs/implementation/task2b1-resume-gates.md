# Resume interrupted Firebase foundation — first prove the real core path

> Historical implementation record — current status updated 18 October 2026. This file preserves its original task scope and evidence; it is not an instruction for new work. For the deployed release, current test counts and known limits, see [STATUS](STATUS.md) and [release verification](../verification/release-2026-10-18.md). Future work follows the levels in [upgrade_plan.md](../../upgrade_plan.md).

Continue SAME conversation3519b64f-17fa-45b0-96a7-effce862d12d, userselectedgemini-3.8-flash-high. Priorrun stopped without result.json/finalreport while user was away. No AGY process or emulator remains. Do not claim completion from priorpartialfiles. Use actualcurrentcode, not remembered intendedchanges. No commit/stage/push/deploy/delegation/review/Astra/payment/billing/globalpermissionschanges.

Original task2b-transport.md and task2b1-core-rework.md remain requirements. THIS bounded step prioritizes making actual production bootstrap/join/ready/config/start/action work against REAL approved rules and restoring typecheck. Then report remaining corehardening. Do not spend time on README/Appcosmetics or newfeatures before proof. No edits to independentlyapproved UI/experience/screens/rounds/ui/styles/questiondata. A separatecompletedcontenttaskchanged ONLYtwo cinema prompts+explanations withsourceverification; preserve those.

Independent current evidence: npm test PASS546tests/16files. npm run typecheck FAIL:
- App.tsx91 unsupported Button variant secondary and size prop; use actual primitives (do not alter UIprimitiveAPI).
- firebase-host-runtime imports ContentSource/MatchConfig/PlayerId/RoomState from @game/engine but those types live @game/shared; fix imports, not broadreexports.
- nullable strings at261/262/299/348; implicitany487.
- engine.tick calledwith2arguments at494/566 but APIaccepts0-1; engine.skip/act do notexist at991/1014: actualmethods skipPhase/submitAction. Inspect actualenginebeforeusingit.
- transport.emulator.test.ts252/255/262/265 callback-mutatedview narrowsnever; use soundtesthelpers/types, not suppressions.
- firebase-transport.ts635 {ok:true} incompatible AckResult<Record<string,never>> default; choose existingworkingprotocolgenerics.
- seat.ts199/200 nullchannelcapturedcallback.

CRITICAL TEST CONFIG: firebase-transport.emulator.test.ts makeTransport currently omits config, therefore resolves LIVEproject yalla-nelaab-20261016 metadata/APIkey/databaseURL even though socketsrouteemulators. This violates the explicitlyrequired demo-only project and may use an emulator namespace with no matchingrules. Supply allfakeconfigvalueswith projectId demo-yalla-nelaab and a matchingdemo databaseURL/namespace; establish/deploy database.rules.json to EXACT namespace used by productionSDK. Use rules-unit-testing initializeTestEnvironment ifneeded. Assert unauthenticated/root/crossplayer reads DENIED on that sameDB so a permissive default namespace cannot produce fakegreen. Neverconnecttests tolivehost/project. No securityRulesDisabled on successful bootstrap/admission; adversarialseedonly.

Run actual npm run test:emulator after typecheckfixes, inspect failures and fixproductionprotocol against realrules. FirstprovecreateRoom returnsflatvalidcredentials+hostview, join returnsdistinctUID+ownprivateview, repeatjoin stablebinding, readiness/config/start and validaction viaactualengineAPI. Testfull8/reject9. Do not add fake/mocktransport, skip tests, weakenrules, swallowdenials, or rewriteexpectationsforbrokenbehavior. Avoid activeSDKbackgroundinstances leakingbetween tests; cleanupverified.

KNOWN CORE DEFECTS STILLVISIBLE (originalreworknotfinished):
- sendCommand computesdeadline early but stillawaits ensureSession/set before starting anytimer; offlinewritecanhangforever. Unconditional remove() labeled'conditionalcancel' is stillunconditional. Use real entrydeadline race and ID-conditional transactioncleanup nonblocking; latecontinuationsguarded.
- snapshot envelope nowexists, but recordAck stillhappensAFTER createSnapshotRecord/commit (~1094): persistdedup beforeatomiccommit and rollbackonfailure. Test afteractualruntime restoration, nottrackerunitonly.
- stopExecution onlyclearstimers/listeners, no ownership-lossflag/generationincrement/queuecancellation, no sessiondisconnect/leaseobserver. Do notclaimthisfixedbecauseenqueuechecksunchangedgeneration. Localleaseexpiry advanceonlyaftercommittedrenewal.
- host view/response SDK optimisticcallbacks stillnotcommit-gated. Productionhost mustnotseefalseacceptedview/ack beforeupdatePromiseaccepts. Test deniedpublishrollback/noacceptedhostevent.
- useGame stillconstructssideeffectfulfactoryviauseMemo; itscleanupsets50msdisposetimerbutnevercancelsduringStrictMode setup, so the mountedclientwillbe disposed. It alsodoesnotinitializeFirebaseauth/connection beforeHomebuttonsrequiringconnected=true. Fix stableeffect-owned lifecycle/bootstrap, noorphanconnections/disposedreuse. Appfieldsetdisablesleavewhilehostwaiting; keepescapecontrolusable. Initialconnectionretry90smustbeavailablewithoutview.
- creationintent/previousroomclose/collisionrecoveryremainunimplemented orunproven; returntooriginalcorebriefafterminimalcoreworks.

Required gates you mustactuallyrun/report: npm run typecheck; npm test; npm run build:web; npm run build:firebase; npm run test:emulator. CoreintegrationmustuseactualSDKandrules,demo-only. Addfocusedsequence/seat/offline/restore/commitnegative tests whenfixingthosebehaviors. Read original9corefindings in task2b1-core-rework.md. Ifallnotfinishedinthisboundedstep, explicitlylistremaining; do notclaimdeploymentready. No placeholders/stubs or newdependencies withoutneed. Codexindependentlyreviewsactualdiffandgatesafterreport; younevercommit/deploy.
