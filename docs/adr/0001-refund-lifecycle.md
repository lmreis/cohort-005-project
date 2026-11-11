---
status: accepted
---

# Refund lifecycle: one final decision per Purchase, and an approved Refund ends the Enrollment

A Refund is requested by the learner, then either approved or declined by an Admin. Once decided it is final, and a Purchase has at most one Refund. Refunds are paid back by hand, so approving *is* paying: Approved means the money has gone back, for the amount paid on the Purchase. An approved Refund ends the learner's Enrollment by setting `enrollments.ended_at`, rather than deleting the row, so the history of who was enrolled is kept and their progress and comments stay where they are.

## Considered Options

- **Delete the Enrollment on approval.** No schema change, and every existing "is enrolled" check would keep working. Rejected because it erases the record that the person was enrolled, which the instructor analytics ("never enrolled", student revenue) rely on.
- **Separate Paid state after Approved.** Rejected for now: nothing pays out automatically, so approving and paying happen in the same moment. Add it if payouts ever become asynchronous.
- **Allow a new Refund after a Decline.** Rejected: if the learner can just ask again, a Decline means nothing. Correcting a wrong decision is a new action, not a new Refund.
- **Let the course's Instructor decide.** Rejected: the money comes back out of the platform, and an Instructor deciding Refunds on their own revenue has a conflict of interest.
- **Refund at the course's list price.** Rejected: the list price can change after the Purchase. The learner gets back what they paid.

## Consequences

- An Enrollment row no longer means access. Every query that answers "is this person enrolled now?" must filter on `isNull(enrollments.ended_at)`. A new query that forgets this gives a refunded learner their access back.
- Analytics counts that describe history (student revenue, "never enrolled") deliberately still include ended Enrollments. Counts that describe current learners (progress and drop-off funnels) exclude them.
- A learner whose Refund was approved can buy the course again. That creates a new Purchase and a new Enrollment, and the new Purchase is eligible for a Refund of its own.
- The 14-day window limits only when a Refund can be requested. An Admin can decide after day 14.
