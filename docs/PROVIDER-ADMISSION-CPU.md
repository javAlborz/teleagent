# Provider admission CPU budget

The provider supervisor has a one-core CPU ceiling within the existing 2.5-core provider slice and three-core Teleagent aggregate ceiling. Memory, process, concurrency and model ceilings are unchanged.

On Hermes, the former quarter-core ceiling intermittently starved the read-only resource topology witness. A traced launch returned `RESOURCE_TOPOLOGY_UNCONFIRMED` after its witness was killed by the 2.5-second parent deadline; no upstream request was reserved. This could leave the supervisor locked until the existing global recovery path proved quiescence.

The higher supervisor CPU ceiling gives CLI integrity verification, topology observation and control polling enough execution time. It does not lengthen or bypass resource admission, permit a model launch without its witness, or increase the aggregate CPU cap. A failed prelaunch still needs truthful recovery. Verify consecutive controller and speech-originated jobs on Hermes before reopening phone ingress.
