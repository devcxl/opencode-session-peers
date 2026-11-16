/**
 * Pure delegation policy: who may supervise a direct child task.
 *
 * These tests never touch a ledger, a host or the plugin entry. They pin the
 * facts the policy requires — a controlled grant, the host's direct-parent
 * fact, one location and one visibility scope — and the refusals that must not
 * be talked around by a model message or a broader correction grant.
 */

import { describe, expect, test } from "bun:test"

import type { WatchTaskRecord } from "../src/domain/watch.ts"
import {
  delegationEnrollmentGate,
  delegationGrantGate,
  delegationTermsDigest,
  readDelegationMode,
  WATCH_DELEGATION_TERMS,
  type DelegationEnrollmentFacts,
  type DelegationGrantRecord,
  type DelegationSessionFact,
} from "../src/watch/delegation.ts"

const PARENT = "ses_parent"
const CHILD = "ses_child"
const DIRECTORY = "/tmp/opencode/project"
const SCOPE = "project-a"

function task(overrides: Partial<WatchTaskRecord> = {}): WatchTaskRecord {
  return {
    taskID: "task-parent",
    initiatorSessionID: PARENT,
    targetSessionID: PARENT,
    goal: "Ship the delegated parser fix",
    mode: "alert",
    watchState: "active",
    taskState: "in-progress",
    version: 3,
    generation: 1,
    attemptsUsed: 0,
    ownerActivation: "act-parent",
    reportedWaits: [],
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  }
}

function grant(overrides: Partial<DelegationGrantRecord> = {}): DelegationGrantRecord {
  return {
    grantID: "grant-1",
    parentTaskID: "task-parent",
    parentSessionID: PARENT,
    parentTaskVersion: 3,
    mode: "limited-correction",
    state: "granted",
    version: 1,
    generation: 1,
    scopeTargetSessionID: CHILD,
    scopeDirectory: DIRECTORY,
    scopePeerScope: SCOPE,
    reviewSummary: WATCH_DELEGATION_TERMS,
    termsDigest: "digest-1",
    confirmationID: "confirm-1",
    grantedAt: 3_000,
    ...overrides,
  }
}

function parent(overrides: Partial<DelegationSessionFact> = {}): DelegationSessionFact {
  return { id: PARENT, directory: DIRECTORY, ...overrides }
}

function child(overrides: Partial<DelegationSessionFact> = {}): DelegationSessionFact {
  return { id: CHILD, parentID: PARENT, directory: DIRECTORY, ...overrides }
}

function enrollment(overrides: Partial<DelegationEnrollmentFacts> = {}): DelegationEnrollmentFacts {
  return {
    parentTask: task(),
    parent: parent(),
    child: child(),
    parentScope: SCOPE,
    childScope: SCOPE,
    grant: grant(),
    existingChild: null,
    ownerActivation: "act-parent",
    closing: false,
    ...overrides,
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    parentTaskID: "task-parent",
    targetSessionID: CHILD,
    mode: "alert" as const,
    requestID: "request-child-1",
    goal: "Fix the delegated parser",
    ...overrides,
  }
}

describe("delegation enrollment policy", () => {
  test("allows one host-verified direct child inside a limited grant", () => {
    const result = delegationEnrollmentGate(enrollment(), request())
    expect(result.allowed).toBe(true)
    expect(result.stopReason).toBeNull()
    expect(result.missingEvidence).toBeNull()
    expect(result.late).toBe(false)
    expect(result.gates.every((gate) => gate.ok)).toBe(true)
  })

  test("an alert-only grant cannot enroll a limited-correction child", () => {
    const result = delegationEnrollmentGate(
      enrollment({ grant: grant({ mode: "alert" }) }),
      request({ mode: "limited-correction" }),
    )
    expect(result.allowed).toBe(false)
    expect(result.stopReason).toBe("mode-not-granted")
  })

  test("no controlled grant means no delegation; a parent's correction grant is not one", () => {
    const result = delegationEnrollmentGate(enrollment({ grant: null }), request())
    expect(result.allowed).toBe(false)
    expect(result.stopReason).toBe("grant-missing")
  })

  test("a revoked or generation-stale grant is refused", () => {
    const revoked = delegationEnrollmentGate(
      enrollment({ grant: grant({ state: "revoked" }) }),
      request(),
    )
    expect(revoked.allowed).toBe(false)
    expect(revoked.stopReason).toBe("grant-revoked")

    const stale = delegationEnrollmentGate(
      enrollment({ grant: grant({ generation: 0 }) }),
      request(),
    )
    expect(stale.allowed).toBe(false)
    expect(stale.stopReason).toBe("grant-stale")
  })

  test("the grant must name this concrete target and this parent task", () => {
    const target = delegationEnrollmentGate(
      enrollment({ grant: grant({ scopeTargetSessionID: "ses_other" }) }),
      request(),
    )
    expect(target.allowed).toBe(false)
    expect(target.stopReason).toBe("target-not-granted")

    const taskMismatch = delegationEnrollmentGate(
      enrollment({ grant: grant({ parentTaskID: "task-other" }) }),
      request(),
    )
    expect(taskMismatch.allowed).toBe(false)
    expect(taskMismatch.stopReason).toBe("grant-stale")
  })

  test("only the host's direct parent fact counts; a grandchild is not a direct child", () => {
    const wrong = delegationEnrollmentGate(
      enrollment({ child: child({ parentID: "ses_other" }) }),
      request(),
    )
    expect(wrong.allowed).toBe(false)
    expect(wrong.stopReason).toBe("parent-not-direct")

    const absent = delegationEnrollmentGate(
      enrollment({ child: child({ parentID: undefined }) }),
      request(),
    )
    expect(absent.allowed).toBe(false)
    expect(absent.stopReason).toBe("parent-not-direct")

    const grandchild = delegationEnrollmentGate(
      enrollment({ child: child({ parentID: "ses_middle" }) }),
      request(),
    )
    expect(grandchild.allowed).toBe(false)
    expect(grandchild.stopReason).toBe("parent-not-direct")
  })

  test("a session the host does not know is refused, not trusted from a claim", () => {
    const noChild = delegationEnrollmentGate(enrollment({ child: null }), request())
    expect(noChild.allowed).toBe(false)
    expect(noChild.stopReason).toBe("child-unknown")

    const noParent = delegationEnrollmentGate(enrollment({ parent: null }), request())
    expect(noParent.allowed).toBe(false)
    expect(noParent.stopReason).toBe("parent-unknown")
  })

  test("cross-location and cross-scope children are refused", () => {
    const elsewhere = delegationEnrollmentGate(
      enrollment({ child: child({ directory: "/tmp/opencode/other" }) }),
      request(),
    )
    expect(elsewhere.allowed).toBe(false)
    expect(elsewhere.stopReason).toBe("location-mismatch")

    const scope = delegationEnrollmentGate(
      enrollment({ childScope: "project-b" }),
      request(),
    )
    expect(scope.allowed).toBe(false)
    expect(scope.stopReason).toBe("scope-mismatch")
  })

  test("a delegated task cannot delegate again", () => {
    const result = delegationEnrollmentGate(
      enrollment({
        parentTask: task({ initiatorSessionID: "ses_top", targetSessionID: PARENT }),
      }),
      request(),
    )
    expect(result.allowed).toBe(false)
    expect(result.stopReason).toBe("parent-not-self")
  })

  test("a paused, ended or completed parent task cannot enroll a child", () => {
    const paused = delegationEnrollmentGate(
      enrollment({ parentTask: task({ watchState: "paused" }) }),
      request(),
    )
    expect(paused.allowed).toBe(false)
    expect(paused.stopReason).toBe("parent-task-inactive")

    const ended = delegationEnrollmentGate(
      enrollment({ parentTask: task({ watchState: "ended" }) }),
      request(),
    )
    expect(ended.allowed).toBe(false)
    expect(ended.stopReason).toBe("parent-task-inactive")

    const completed = delegationEnrollmentGate(
      enrollment({ parentTask: task({ taskState: "completed" }) }),
      request(),
    )
    expect(completed.allowed).toBe(false)
    expect(completed.stopReason).toBe("parent-task-completed")
  })

  test("another activation owning the parent task cannot enroll", () => {
    const result = delegationEnrollmentGate(
      enrollment({ ownerActivation: "act-other" }),
      request(),
    )
    expect(result.allowed).toBe(false)
    expect(result.stopReason).toBe("owner-mismatch")
  })

  test("a finished child is not enrolled again; late enrollment is classified, not woken", () => {
    const completed = delegationEnrollmentGate(
      enrollment({
        existingChild: {
          task: task({
            taskID: "task-child",
            targetSessionID: CHILD,
            initiatorSessionID: PARENT,
            taskState: "completed",
            watchState: "ended",
          }),
          delegatedByThisGrant: true,
        },
      }),
      request(),
    )
    expect(completed.allowed).toBe(false)
    expect(completed.stopReason).toBe("child-completed")

    const begun = delegationEnrollmentGate(
      enrollment({
        existingChild: {
          task: task({
            taskID: "task-child",
            targetSessionID: CHILD,
            initiatorSessionID: PARENT,
            taskState: "in-progress",
          }),
          delegatedByThisGrant: true,
        },
      }),
      request(),
    )
    expect(begun.allowed).toBe(true)
    expect(begun.late).toBe(true)
  })

  test("a live child task from another authorization is busy, not adopted", () => {
    const result = delegationEnrollmentGate(
      enrollment({
        existingChild: {
          task: task({
            taskID: "task-child",
            targetSessionID: CHILD,
            initiatorSessionID: PARENT,
          }),
          delegatedByThisGrant: false,
        },
      }),
      request(),
    )
    expect(result.allowed).toBe(false)
    expect(result.stopReason).toBe("child-busy")
  })

  test("a closing application enrolls nothing", () => {
    const result = delegationEnrollmentGate(enrollment({ closing: true }), request())
    expect(result.allowed).toBe(false)
    expect(result.stopReason).toBe("closing")
  })

  test("delegation policy has no model-approval input: a plain mode request cannot widen an alert grant", () => {
    // There is deliberately no `modelApproved`, `userSaidYes` or message field
    // in the policy input. The only path to a wider mode is a controlled grant.
    const input = enrollment({ grant: grant({ mode: "alert" }) })
    const widened = delegationEnrollmentGate(input, request({ mode: "limited-correction" }))
    expect(widened.allowed).toBe(false)
    expect(widened.stopReason).toBe("mode-not-granted")
  })
})

describe("delegation grant policy (controlled surface)", () => {
  test("a self-enrolled parent may grant one direct child in its own scope", () => {
    const result = delegationGrantGate({
      parentTask: task(),
      callerSessionID: PARENT,
      ownerActivation: "act-parent",
      expectedVersion: 3,
      targetSessionID: CHILD,
      mode: "limited-correction",
      parent: parent(),
      child: child(),
      parentScope: SCOPE,
      childScope: SCOPE,
      existingGrant: null,
      closing: false,
    })
    expect(result.allowed).toBe(true)
    expect(result.stopReason).toBeNull()
  })

  test("the caller must be the parent task's initiator and current owner", () => {
    const caller = delegationGrantGate({
      parentTask: task(),
      callerSessionID: "ses_other",
      ownerActivation: "act-parent",
      expectedVersion: 3,
      targetSessionID: CHILD,
      mode: "alert",
      parent: parent(),
      child: child(),
      parentScope: SCOPE,
      childScope: SCOPE,
      existingGrant: null,
      closing: false,
    })
    expect(caller.allowed).toBe(false)
    expect(caller.stopReason).toBe("owner-mismatch")

    const stale = delegationGrantGate({
      parentTask: task(),
      callerSessionID: PARENT,
      ownerActivation: "act-parent",
      expectedVersion: 2,
      targetSessionID: CHILD,
      mode: "alert",
      parent: parent(),
      child: child(),
      parentScope: SCOPE,
      childScope: SCOPE,
      existingGrant: null,
      closing: false,
    })
    expect(stale.allowed).toBe(false)
    expect(stale.stopReason).toBe("parent-version-stale")
  })

  test("an active grant must be revoked before another can be prepared", () => {
    const result = delegationGrantGate({
      parentTask: task(),
      callerSessionID: PARENT,
      ownerActivation: "act-parent",
      expectedVersion: 3,
      targetSessionID: CHILD,
      mode: "alert",
      parent: parent(),
      child: child(),
      parentScope: SCOPE,
      childScope: SCOPE,
      existingGrant: grant(),
      closing: false,
    })
    expect(result.allowed).toBe(false)
    expect(result.stopReason).toBe("grant-active")
  })

  test("a grant cannot name a non-direct or cross-scope child", () => {
    const unrelated = delegationGrantGate({
      parentTask: task(),
      callerSessionID: PARENT,
      ownerActivation: "act-parent",
      expectedVersion: 3,
      targetSessionID: CHILD,
      mode: "alert",
      parent: parent(),
      child: child({ parentID: "ses_other" }),
      parentScope: SCOPE,
      childScope: SCOPE,
      existingGrant: null,
      closing: false,
    })
    expect(unrelated.allowed).toBe(false)
    expect(unrelated.stopReason).toBe("parent-not-direct")

    const crossScope = delegationGrantGate({
      parentTask: task(),
      callerSessionID: PARENT,
      ownerActivation: "act-parent",
      expectedVersion: 3,
      targetSessionID: CHILD,
      mode: "alert",
      parent: parent(),
      child: child(),
      parentScope: SCOPE,
      childScope: "project-b",
      existingGrant: null,
      closing: false,
    })
    expect(crossScope.allowed).toBe(false)
    expect(crossScope.stopReason).toBe("scope-mismatch")
  })
})

describe("delegation terms and bounded input", () => {
  test("terms state the one-level, non-automatic and non-retracting boundary", () => {
    const terms = WATCH_DELEGATION_TERMS.toLowerCase()
    expect(terms).toContain("direct child")
    expect(terms).toContain("one level")
    expect(terms).toContain("does not grant automatic correction")
    expect(terms).toContain("revocation")
    expect(terms).toContain("accepted messages")
    expect(terms).toContain("spent attempts")
  })

  test("the digest binds the parent task, child, mode, location and scope", () => {
    const base = {
      parentTaskID: "task-parent",
      parentSessionID: PARENT,
      targetSessionID: CHILD,
      mode: "alert" as const,
      directory: DIRECTORY,
      peerScope: SCOPE,
    }
    const first = delegationTermsDigest(base)
    expect(first).toBe(delegationTermsDigest({ ...base }))
    expect(first).not.toBe(delegationTermsDigest({ ...base, targetSessionID: "ses_other" }))
    expect(first).not.toBe(delegationTermsDigest({ ...base, mode: "limited-correction" }))
    expect(first).not.toBe(delegationTermsDigest({ ...base, directory: "/tmp/opencode/other" }))
    expect(first).not.toBe(delegationTermsDigest({ ...base, peerScope: "project-b" }))
  })

  test("only the two known modes are accepted", () => {
    expect(readDelegationMode("alert")).toEqual({ ok: true, value: "alert" })
    expect(readDelegationMode("limited-correction")).toEqual({ ok: true, value: "limited-correction" })
    expect(readDelegationMode("everything").ok).toBe(false)
    expect(readDelegationMode(undefined).ok).toBe(false)
  })
})
