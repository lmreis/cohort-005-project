import { useEffect } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import type { Route } from "./+types/admin.refunds";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { decideRefund } from "~/lib/refunds.server";
import { formatPrice } from "~/lib/utils";
import { db } from "~/db";
import {
  courses,
  purchases,
  refunds,
  users,
  RefundStatus,
  UserRole,
} from "~/db/schema";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { AlertTriangle, Undo2 } from "lucide-react";

const decideRefundSchema = z.object({
  refundId: z.coerce.number().int(),
  decision: z.enum(["approve", "decline"]),
});

function getUserById(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

function getRequestedRefunds() {
  return db
    .select({
      id: refunds.id,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      amountPaid: purchases.amountPaid,
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.status, RefundStatus.Requested))
    .orderBy(asc(refunds.requestedAt))
    .all();
}

function getRefundRecipient(refundId: number) {
  return db
    .select({
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, refundId))
    .get();
}

/**
 * The follow-up the request email promises. There is no mail transport wired
 * up yet, so the built message goes to the server log.
 */
function buildRefundDecisionEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  approved: boolean;
  amountRefunded: number | null;
}) {
  const outcome = input.approved
    ? [
        `Your refund for "${input.courseTitle}" has been approved.`,
        `We have sent ${formatPrice(input.amountRefunded ?? 0)} back to the card you paid with, and your access to the course has ended.`,
      ]
    : [
        `Your refund request for "${input.courseTitle}" has been declined.`,
        "You keep your access to the course.",
      ];

  return {
    to: input.learnerEmail,
    subject: `Refund ${input.approved ? "approved" : "declined"} — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      ...outcome,
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

async function requireAdmin(request: Request) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to manage refunds.", {
      status: 401,
    });
  }

  const currentUser = getUserById(currentUserId);
  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only admins can access this page.", { status: 403 });
  }

  return currentUser;
}

export function meta() {
  return [
    { title: "Refunds — Cadence" },
    { name: "description", content: "Approve or decline refund requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  return { refunds: getRequestedRefunds() };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, decideRefundSchema);

  if (!parsed.success) {
    return data(
      { error: Object.values(parsed.errors)[0] ?? "Invalid input." },
      { status: 400 }
    );
  }

  const { refundId, decision } = parsed.data;
  const result = decideRefund(admin.id, refundId, decision, new Date());

  if (!result.ok) {
    return data({ error: result.message }, { status: result.status });
  }

  const recipient = getRefundRecipient(refundId);
  if (recipient) {
    const email = buildRefundDecisionEmail({
      ...recipient,
      approved: result.refund.status === RefundStatus.Approved,
      amountRefunded: result.refund.amountRefunded,
    });
    console.log(
      `[email] to=${email.to} subject=${email.subject}\n${email.body}`
    );
  }

  return { success: true, decision };
}

function RefundRow({
  refund,
}: {
  refund: ReturnType<typeof getRequestedRefunds>[number];
}) {
  const fetcher = useFetcher<{
    success?: boolean;
    decision?: string;
    error?: string;
  }>();
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    if (fetcher.data?.success) {
      toast.success(
        fetcher.data.decision === "approve"
          ? "Refund approved."
          : "Refund declined."
      );
    }
    if (fetcher.data?.error) {
      toast.error(fetcher.data.error);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="px-4 py-3">
        <div className="font-medium">{refund.learnerName}</div>
        <div className="text-xs text-muted-foreground">
          {refund.learnerEmail}
        </div>
      </td>
      <td className="px-4 py-3">
        <Link to={`/courses/${refund.courseSlug}`} className="hover:underline">
          {refund.courseTitle}
        </Link>
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        {formatPrice(refund.amountPaid)}
      </td>
      <td className="max-w-sm px-4 py-3 text-sm">{refund.reason}</td>
      <td className="px-4 py-3 text-sm whitespace-nowrap text-muted-foreground">
        {new Date(refund.requestedAt).toLocaleDateString()}
      </td>
      <td className="px-4 py-3">
        <fetcher.Form method="post" className="flex gap-2">
          <input type="hidden" name="refundId" value={refund.id} />
          <Button
            type="submit"
            name="decision"
            value="approve"
            size="sm"
            disabled={isSubmitting}
          >
            Approve
          </Button>
          <Button
            type="submit"
            name="decision"
            value="decline"
            variant="outline"
            size="sm"
            disabled={isSubmitting}
          >
            Decline
          </Button>
        </fetcher.Form>
      </td>
    </tr>
  );
}

const HEADER_CELL =
  "px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground";

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { refunds } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refunds</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refunds</h1>
        <p className="mt-1 text-muted-foreground">
          Approving sends the amount paid back and ends the learner&apos;s
          access to the course. Decisions are final.
        </p>
      </div>

      {refunds.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Undo2 className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              No refunds are waiting for a decision.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className={HEADER_CELL}>Learner</th>
                    <th className={HEADER_CELL}>Course</th>
                    <th className={HEADER_CELL}>Amount paid</th>
                    <th className={HEADER_CELL}>Reason</th>
                    <th className={HEADER_CELL}>Requested</th>
                    <th className={HEADER_CELL}>Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {refunds.map((refund) => (
                    <RefundRow key={refund.id} refund={refund} />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refunds.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "Only admins can access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
