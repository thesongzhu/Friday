# Fleet

Target users:
- distributed runtime operators
- anyone pairing devices or running satellites

Page tasks:
- see node and satellite health
- inspect pairing status
- inspect sync lag and execution availability
- recover unhealthy nodes

Module order:
1. Fleet summary
2. Node and satellite list
3. Pairing state
4. Sync health
5. Selected node detail and recovery actions

Desktop layout:
- overview strip on top
- node list plus selected node detail
- pairing and sync modules below or beside detail

Mobile mapping:
- summary
- node cards
- pairing and sync cards
- node detail in drill-in

Right-rail chat linkage:
- inject selected node, sync state, pairing blockers, health summary
- quick actions: diagnose node, restart path, explain drift

States:
- loading: node list skeleton
- empty: explain how to pair or add the first node
- error: keep last-known fleet state visible with stale markers
- partial: node list works even if sync telemetry is delayed
- success: health, pairing, and sync tell one coherent story

Forbidden:
- no device inventory without health meaning
- no pairing issue hidden inside generic settings
- no recovery path that assumes backend-only knowledge
