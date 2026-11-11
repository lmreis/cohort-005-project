import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";
import { decideRefund, getRefundEligibility } from "./refunds.server";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

const PURCHASED_AT = "2026-03-10T12:00:00.000Z";
const DAY_AFTER_PURCHASE = new Date("2026-03-11T12:00:00.000Z");

let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

function buy(amountPaid: number) {
  testDb
    .insert(schema.enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();
  return testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid,
      createdAt: PURCHASED_AT,
    })
    .returning()
    .get();
}

function addLessons(count: number) {
  const module = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module", position: 1 })
    .returning()
    .get();
  return Array.from({ length: count }, (_, index) =>
    testDb
      .insert(schema.lessons)
      .values({
        moduleId: module.id,
        title: `Lesson ${index}`,
        position: index,
      })
      .returning()
      .get()
  );
}

function complete(lessonId: number) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId: base.user.id,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
    })
    .run();
}

describe("getRefundEligibility", () => {
  it("offers a Refund of the amount paid, not the current list price", () => {
    buy(4900);
    testDb.update(schema.courses).set({ price: 7900 }).run();

    const eligibility = getRefundEligibility(
      base.user.id,
      base.course.id,
      DAY_AFTER_PURCHASE
    );

    expect(eligibility).toMatchObject({
      eligible: true,
      amount: 4900,
      lastDayInWindow: "2026-03-24",
    });
  });

  it("stays open through the last day of the window and closes the day after", () => {
    buy(4900);

    const lastDay = getRefundEligibility(
      base.user.id,
      base.course.id,
      new Date("2026-03-24T23:30:00")
    );
    const dayAfter = getRefundEligibility(
      base.user.id,
      base.course.id,
      new Date("2026-03-25T00:30:00")
    );

    expect(lastDay.eligible).toBe(true);
    expect(dayAfter).toEqual({
      eligible: false,
      message: "The 14-day window has closed.",
    });
  });

  it.each([
    schema.RefundStatus.Requested,
    schema.RefundStatus.Approved,
    schema.RefundStatus.Declined,
  ])("refuses a second Refund on a Purchase whose Refund is %s", (status) => {
    const purchase = buy(4900);
    testDb
      .insert(schema.refunds)
      .values({ purchaseId: purchase.id, status, reason: "Not for me" })
      .run();

    expect(
      getRefundEligibility(base.user.id, base.course.id, DAY_AFTER_PURCHASE)
    ).toEqual({
      eligible: false,
      message: "This purchase already has a refund.",
    });
  });

  it("refuses once half the lessons are completed, but not before", () => {
    buy(4900);
    const lessons = addLessons(4);

    complete(lessons[0].id);
    const oneOfFour = getRefundEligibility(
      base.user.id,
      base.course.id,
      DAY_AFTER_PURCHASE
    );

    complete(lessons[1].id);
    const twoOfFour = getRefundEligibility(
      base.user.id,
      base.course.id,
      DAY_AFTER_PURCHASE
    );

    expect(oneOfFour.eligible).toBe(true);
    expect(twoOfFour).toEqual({
      eligible: false,
      message: "You have completed too much of this course to get a refund.",
    });
  });

  it("refuses once two hours of video have been watched, counting the furthest point in each lesson", () => {
    buy(4900);
    const [first, second] = addLessons(2);
    const watch = (lessonId: number, positionSeconds: number) =>
      testDb
        .insert(schema.videoWatchEvents)
        .values({
          userId: base.user.id,
          lessonId,
          eventType: "progress",
          positionSeconds,
        })
        .run();

    // Rewatching the same stretch doesn't add up: one hour, seen twice.
    watch(first.id, 1800);
    watch(first.id, 3600);
    watch(first.id, 3600);
    watch(second.id, 3599);
    const justUnder = getRefundEligibility(
      base.user.id,
      base.course.id,
      DAY_AFTER_PURCHASE
    );

    watch(second.id, 3600);
    const twoHours = getRefundEligibility(
      base.user.id,
      base.course.id,
      DAY_AFTER_PURCHASE
    );

    expect(justUnder.eligible).toBe(true);
    expect(twoHours).toEqual({
      eligible: false,
      message: "You have watched too much of this course to get a refund.",
    });
  });

  it("refuses a team Purchase once any of its seats is claimed", () => {
    const purchase = buy(9800);
    const team = testDb.insert(schema.teams).values({}).returning().get();
    const addSeat = (code: string) =>
      testDb
        .insert(schema.coupons)
        .values({
          teamId: team.id,
          courseId: base.course.id,
          code,
          purchaseId: purchase.id,
        })
        .returning()
        .get();

    const seat = addSeat("SEAT-1");
    addSeat("SEAT-2");
    const noneClaimed = getRefundEligibility(
      base.user.id,
      base.course.id,
      DAY_AFTER_PURCHASE
    );

    testDb
      .update(schema.coupons)
      .set({ redeemedByUserId: base.instructor.id, redeemedAt: PURCHASED_AT })
      .where(eq(schema.coupons.id, seat.id))
      .run();
    const oneClaimed = getRefundEligibility(
      base.user.id,
      base.course.id,
      DAY_AFTER_PURCHASE
    );

    expect(noneClaimed.eligible).toBe(true);
    expect(oneClaimed).toEqual({
      eligible: false,
      message: "A claimed team seat cannot be refunded.",
    });
  });

  it("refuses when there is no Purchase", () => {
    expect(
      getRefundEligibility(base.user.id, base.course.id, DAY_AFTER_PURCHASE)
    ).toEqual({ eligible: false, message: "You have not bought this course." });
  });
});

describe("decideRefund", () => {
  const DECIDED_AT = new Date("2026-04-02T09:00:00.000Z");
  let admin: typeof schema.users.$inferSelect;

  beforeEach(() => {
    admin = testDb
      .insert(schema.users)
      .values({
        name: "Admin",
        email: "admin@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
  });

  function requestRefund(amountPaid: number) {
    const purchase = buy(amountPaid);
    return testDb
      .insert(schema.refunds)
      .values({ purchaseId: purchase.id, reason: "Not what I expected" })
      .returning()
      .get();
  }

  function enrollmentOf(userId: number) {
    return testDb
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.userId, userId))
      .get();
  }

  it("approving gives back the amount paid and ends the Enrollment, keeping progress", () => {
    const refund = requestRefund(4900);
    testDb.update(schema.courses).set({ price: 7900 }).run();
    const [lesson] = addLessons(1);
    complete(lesson.id);

    const result = decideRefund(admin.id, refund.id, "approve", DECIDED_AT);

    expect(result).toMatchObject({
      ok: true,
      refund: {
        status: schema.RefundStatus.Approved,
        amountRefunded: 4900,
        resolvedAt: DECIDED_AT.toISOString(),
        resolvedByUserId: admin.id,
      },
    });
    expect(enrollmentOf(base.user.id)?.endedAt).toBe(DECIDED_AT.toISOString());
    expect(testDb.select().from(schema.lessonProgress).all()).toHaveLength(1);
  });

  it("declining gives nothing back and keeps the Enrollment", () => {
    const refund = requestRefund(4900);

    const result = decideRefund(admin.id, refund.id, "decline", DECIDED_AT);

    expect(result).toMatchObject({
      ok: true,
      refund: {
        status: schema.RefundStatus.Declined,
        amountRefunded: null,
        resolvedByUserId: admin.id,
      },
    });
    expect(enrollmentOf(base.user.id)?.endedAt).toBeNull();
  });

  it.each(["approve", "decline"] as const)(
    "refuses to %s a Refund that has already been decided",
    (secondDecision) => {
      const refund = requestRefund(4900);
      decideRefund(admin.id, refund.id, "decline", DECIDED_AT);

      expect(
        decideRefund(admin.id, refund.id, secondDecision, DECIDED_AT)
      ).toEqual({
        ok: false,
        status: 409,
        message: "This refund has already been decided.",
      });
      expect(enrollmentOf(base.user.id)?.endedAt).toBeNull();
    }
  );

  it.each([
    ["the course's Instructor", () => base.instructor.id],
    ["the learner", () => base.user.id],
  ])("refuses a decision by %s", (_who, deciderId) => {
    const refund = requestRefund(4900);

    expect(decideRefund(deciderId(), refund.id, "approve", DECIDED_AT)).toEqual(
      {
        ok: false,
        status: 403,
        message: "Only an admin can decide a refund.",
      }
    );
    expect(enrollmentOf(base.user.id)?.endedAt).toBeNull();
  });
});
