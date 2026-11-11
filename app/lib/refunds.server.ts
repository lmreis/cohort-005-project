import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  max,
} from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  enrollments,
  users,
  RefundStatus,
  UserRole,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  videoWatchEvents,
  LessonProgressStatus,
} from "~/db/schema";

export const REFUND_WINDOW_DAYS = 14;
/** Share of the course's lessons completed at which a Refund is refused. */
const REFUND_COMPLETION_LIMIT = 0.5;
const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;

// ─── Refunds ───
// The one place that knows the Refund rules. See **Refund** in GLOSSARY.md.
// Uses positional parameters (project convention).

export type RefundEligibility =
  | {
      eligible: true;
      purchaseId: number;
      /** What goes back: always the amount paid on the Purchase. */
      amount: number;
      /** Last calendar day (YYYY-MM-DD, local time) a Refund can be requested. */
      lastDayInWindow: string;
    }
  | { eligible: false; message: string };

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(desc(purchases.createdAt))
    .get();
}

function getRefundForPurchase(purchaseId: number) {
  return db
    .select({ id: refunds.id })
    .from(refunds)
    .where(eq(refunds.purchaseId, purchaseId))
    .get();
}

function hasClaimedSeat(purchaseId: number) {
  return !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();
}

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  const result = db
    .select({ count: count() })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();
  return result?.count ?? 0;
}

// Counts the furthest point reached in each lesson, so rewatching a stretch
// doesn't count twice.
function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  return db
    .select({ furthest: max(videoWatchEvents.positionSeconds) })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + (row.furthest ?? 0), 0);
}

// The window is counted in whole days, not hours — someone who buys at 23:00
// should still get the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

/**
 * Can this user request a Refund on their Purchase of this course right now?
 * Both the course page's offer and the refund route ask this, so they agree.
 */
export function getRefundEligibility(
  userId: number,
  courseId: number,
  now: Date
): RefundEligibility {
  const purchase = getLatestPurchase(userId, courseId);

  if (!purchase) {
    return { eligible: false, message: "You have not bought this course." };
  }

  // A Purchase has at most one Refund, whatever became of it.
  if (getRefundForPurchase(purchase.id)) {
    return { eligible: false, message: "This purchase already has a refund." };
  }

  // A claimed seat belongs to the team member who took it; the buyer can't
  // hand it back on their own.
  if (hasClaimedSeat(purchase.id)) {
    return {
      eligible: false,
      message: "A claimed team seat cannot be refunded.",
    };
  }

  const windowEnd = new Date(purchase.createdAt);
  windowEnd.setDate(windowEnd.getDate() + REFUND_WINDOW_DAYS);
  const lastDayInWindow = calendarDay(windowEnd);

  if (calendarDay(now) > lastDayInWindow) {
    return {
      eligible: false,
      message: `The ${REFUND_WINDOW_DAYS}-day window has closed.`,
    };
  }

  const lessonIds = getLessonIdsForCourse(courseId);

  if (
    lessonIds.length > 0 &&
    getCompletedLessonCount(userId, lessonIds) / lessonIds.length >=
      REFUND_COMPLETION_LIMIT
  ) {
    return {
      eligible: false,
      message: "You have completed too much of this course to get a refund.",
    };
  }

  if (getSecondsWatched(userId, lessonIds) >= REFUND_WATCH_LIMIT_SECONDS) {
    return {
      eligible: false,
      message: "You have watched too much of this course to get a refund.",
    };
  }

  return {
    eligible: true,
    purchaseId: purchase.id,
    amount: purchase.amountPaid,
    lastDayInWindow,
  };
}

/**
 * Records a Requested Refund, if the learner is eligible for one right now.
 */
export function requestRefund(
  userId: number,
  courseId: number,
  reason: string,
  now: Date
):
  | { ok: true; refund: typeof refunds.$inferSelect; amount: number }
  | { ok: false; message: string } {
  const eligibility = getRefundEligibility(userId, courseId, now);
  if (!eligibility.eligible) {
    return { ok: false, message: eligibility.message };
  }

  const refund = db
    .insert(refunds)
    .values({
      purchaseId: eligibility.purchaseId,
      status: RefundStatus.Requested,
      reason,
      requestedAt: now.toISOString(),
    })
    .returning()
    .get();

  return { ok: true, refund, amount: eligibility.amount };
}

export type RefundDecision = "approve" | "decline";

export type DecideRefundResult =
  | { ok: true; refund: typeof refunds.$inferSelect }
  | { ok: false; status: 403 | 404 | 409; message: string };

/**
 * An Admin approves or declines a Requested Refund. The decision is final.
 * Approving means the money has gone back: it records the amount paid and
 * ends the learner's Enrollment, keeping their progress.
 */
export function decideRefund(
  deciderId: number,
  refundId: number,
  decision: RefundDecision,
  now: Date
): DecideRefundResult {
  const decider = db.select().from(users).where(eq(users.id, deciderId)).get();
  if (decider?.role !== UserRole.Admin) {
    return {
      ok: false,
      status: 403,
      message: "Only an admin can decide a refund.",
    };
  }

  const refund = db
    .select()
    .from(refunds)
    .where(eq(refunds.id, refundId))
    .get();
  if (!refund) {
    return { ok: false, status: 404, message: "Refund not found." };
  }

  if (refund.status !== RefundStatus.Requested) {
    return {
      ok: false,
      status: 409,
      message: "This refund has already been decided.",
    };
  }

  const purchase = db
    .select()
    .from(purchases)
    .where(eq(purchases.id, refund.purchaseId))
    .get();
  if (!purchase) {
    return { ok: false, status: 404, message: "Purchase not found." };
  }

  const resolvedAt = now.toISOString();

  return db.transaction((tx): DecideRefundResult => {
    // Guarded on the status too, so two Admins deciding at once can't both win.
    const decided = tx
      .update(refunds)
      .set({
        status:
          decision === "approve"
            ? RefundStatus.Approved
            : RefundStatus.Declined,
        amountRefunded: decision === "approve" ? purchase.amountPaid : null,
        resolvedAt,
        resolvedByUserId: deciderId,
      })
      .where(
        and(
          eq(refunds.id, refundId),
          eq(refunds.status, RefundStatus.Requested)
        )
      )
      .returning()
      .get();

    if (!decided) {
      return {
        ok: false,
        status: 409,
        message: "This refund has already been decided.",
      };
    }

    if (decision === "approve") {
      tx.update(enrollments)
        .set({ endedAt: resolvedAt })
        .where(
          and(
            eq(enrollments.userId, purchase.userId),
            eq(enrollments.courseId, purchase.courseId),
            isNull(enrollments.endedAt)
          )
        )
        .run();
    }

    return { ok: true, refund: decided };
  });
}
