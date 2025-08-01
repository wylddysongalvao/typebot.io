import { env } from "@typebot.io/env";
import { methodNotAllowed } from "@typebot.io/lib/api/utils";
import prisma from "@typebot.io/prisma";
import { Plan, WorkspaceRole } from "@typebot.io/prisma/enum";
import type { Settings } from "@typebot.io/settings/schemas";
import { trackEvents } from "@typebot.io/telemetry/trackEvents";
import { buffer } from "micro";
import type { NextApiRequest, NextApiResponse } from "next";
import { Stripe } from "stripe";
import { prices } from "../constants";

if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET)
  throw new Error("STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET missing");

const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-09-30.acacia",
});

const webhookSecret = env.STRIPE_WEBHOOK_SECRET as string;

export const webhookHandler = async (
  req: NextApiRequest,
  res: NextApiResponse,
) => {
  if (req.method === "POST") {
    const buf = await buffer(req);
    const sig = req.headers["stripe-signature"];

    if (!sig) return res.status(400).send(`stripe-signature is missing`);
    try {
      const event = stripe.webhooks.constructEvent(
        buf.toString(),
        sig.toString(),
        webhookSecret,
      );
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const metadata = session.metadata as unknown as
            | {
                plan: "STARTER" | "PRO";
                workspaceId: string;
                userId: string;
              }
            | { claimableCustomPlanId: string; userId: string };
          if ("plan" in metadata) {
            const { workspaceId, plan } = metadata;
            if (!workspaceId || !plan)
              return res
                .status(500)
                .send({ message: `Couldn't retrieve valid metadata` });

            const workspace = await prisma.workspace.update({
              where: { id: workspaceId },
              data: {
                plan,
                stripeId: session.customer as string,
                isQuarantined: false,
              },
              include: {
                members: {
                  select: { userId: true },
                  where: {
                    role: WorkspaceRole.ADMIN,
                  },
                },
              },
            });

            await trackEvents(
              workspace.members.map((m) => ({
                name: "Subscription updated",
                workspaceId,
                userId: m.userId,
                data: {
                  prevPlan: Plan.FREE,
                  plan,
                },
              })),
            );
          } else {
            const { claimableCustomPlanId, userId } = metadata;
            if (!claimableCustomPlanId)
              return res
                .status(500)
                .send({ message: `Couldn't retrieve valid metadata` });
            const { workspaceId, chatsLimit, seatsLimit, storageLimit } =
              await prisma.claimableCustomPlan.update({
                where: { id: claimableCustomPlanId },
                data: { claimedAt: new Date() },
              });

            await prisma.workspace.updateMany({
              where: { id: workspaceId },
              data: {
                plan: Plan.CUSTOM,
                stripeId: session.customer as string,
                customChatsLimit: chatsLimit,
                customStorageLimit: storageLimit,
                customSeatsLimit: seatsLimit,
              },
            });

            await trackEvents([
              {
                name: "Subscription updated",
                workspaceId,
                userId,
                data: {
                  prevPlan: Plan.FREE,
                  plan: Plan.CUSTOM,
                },
              },
            ]);
          }

          return res.status(200).send({ message: "workspace upgraded in DB" });
        }
        case "customer.subscription.updated": {
          const subscription = event.data.object as Stripe.Subscription;
          const previous = event.data.previous_attributes;

          if (previous?.status === "incomplete")
            return res.send({
              message: "Subscription just created, skipping.",
            });

          const existingWorkspace = await prisma.workspace.findFirst({
            where: {
              stripeId: subscription.customer as string,
            },
            select: {
              isPastDue: true,
              id: true,
              plan: true,
              members: {
                select: { userId: true, role: true },
                where: { role: WorkspaceRole.ADMIN },
              },
            },
          });
          if (!existingWorkspace) throw new Error("Workspace not found");

          if (
            subscription.cancel_at_period_end &&
            previous?.cancel_at_period_end === false
          )
            await trackEvents(
              existingWorkspace.members.map((m) => ({
                name: "Subscription scheduled for cancellation",
                workspaceId: existingWorkspace.id,
                userId: m.userId,
                data: {
                  plan:
                    existingWorkspace.plan === Plan.PRO
                      ? Plan.PRO
                      : Plan.STARTER,
                },
              })),
            );
          if (
            previous?.cancel_at_period_end &&
            !subscription.cancel_at_period_end
          )
            await trackEvents(
              existingWorkspace.members.map((m) => ({
                name: "Subscription cancellation removed",
                workspaceId: existingWorkspace.id,
                userId: m.userId,
                data: {
                  plan:
                    existingWorkspace.plan === Plan.PRO
                      ? Plan.PRO
                      : Plan.STARTER,
                },
              })),
            );

          if (subscription.status !== "past_due" || existingWorkspace.isPastDue)
            return res.send({
              message: "Not newly past due, skipping.",
            });

          await prisma.workspace.updateMany({
            where: {
              id: existingWorkspace.id,
            },
            data: {
              isPastDue: true,
            },
          });

          await trackEvents(
            existingWorkspace.members.map((m) => ({
              name: "Workspace past due",
              workspaceId: existingWorkspace.id,
              userId: m.userId,
            })),
          );
          return res.send({ message: "Workspace set to past due." });
        }
        case "invoice.paid": {
          const invoice = event.data.object as Stripe.Invoice;
          const workspace = await prisma.workspace.findFirst({
            where: {
              stripeId: invoice.customer as string,
            },
            select: {
              isPastDue: true,
            },
          });
          if (!workspace?.isPastDue)
            return res.send({ message: "Workspace not past_due, skipping." });
          const outstandingInvoices = await stripe.invoices.list({
            customer: invoice.customer as string,
            status: "open",
          });
          const outstandingInvoicesWithAdditionalUsageCosts =
            outstandingInvoices.data.filter(
              (invoice) => invoice.amount_due > prices["PRO"] * 100,
            );
          if (outstandingInvoicesWithAdditionalUsageCosts.length > 0)
            return res.send({
              message: "Workspace has outstanding invoices, skipping.",
            });
          const updatedWorkspace = await prisma.workspace.update({
            where: {
              stripeId: invoice.customer as string,
            },
            data: {
              isPastDue: false,
            },
            select: {
              id: true,
              members: {
                select: { userId: true },
                where: {
                  role: WorkspaceRole.ADMIN,
                },
              },
            },
          });
          await trackEvents(
            updatedWorkspace.members.map((m) => ({
              name: "Workspace past due status removed",
              workspaceId: updatedWorkspace.id,
              userId: m.userId,
            })),
          );
          return res.send({ message: "Workspace was regulated" });
        }
        case "customer.subscription.deleted": {
          const subscription = event.data.object as Stripe.Subscription;
          const { data } = await stripe.subscriptions.list({
            customer: subscription.customer as string,
            limit: 1,
            status: "active",
          });
          const existingSubscription = data[0] as
            | Stripe.Subscription
            | undefined;
          if (existingSubscription)
            return res.send({
              message:
                "An active subscription still exists. Skipping downgrade.",
            });
          const outstandingInvoices = await stripe.invoices.list({
            customer: subscription.customer as string,
            status: "open",
          });
          const outstandingInvoicesWithAdditionalUsageCosts =
            outstandingInvoices.data.filter(
              (invoice) => invoice.amount_due > prices["PRO"] * 100,
            );

          const existingWorkspace = await prisma.workspace.findFirst({
            where: {
              stripeId: subscription.customer as string,
            },
            select: {
              plan: true,
            },
          });

          if (!existingWorkspace)
            return res.send({ message: "Workspace not found, skipping..." });

          const workspace = await prisma.workspace.update({
            where: {
              stripeId: subscription.customer as string,
            },
            data: {
              plan: Plan.FREE,
              customChatsLimit: null,
              customStorageLimit: null,
              customSeatsLimit: null,
              isPastDue: outstandingInvoicesWithAdditionalUsageCosts.length > 0,
            },
            include: {
              members: {
                select: { userId: true },
                where: {
                  role: WorkspaceRole.ADMIN,
                },
              },
            },
          });

          await trackEvents(
            workspace.members.map((m) => ({
              name: "Subscription updated",
              workspaceId: workspace.id,
              userId: m.userId,
              data: {
                prevPlan: existingWorkspace.plan,
                plan: Plan.FREE,
              },
            })),
          );

          const typebots = await prisma.typebot.findMany({
            where: {
              workspaceId: workspace.id,
              isArchived: { not: true },
            },
            include: { publishedTypebot: true },
          });
          for (const typebot of typebots) {
            const settings = typebot.settings as Settings;
            if (settings.general?.isBrandingEnabled) continue;
            await prisma.typebot.updateMany({
              where: { id: typebot.id },
              data: {
                settings: {
                  ...settings,
                  general: {
                    ...settings.general,
                    isBrandingEnabled: true,
                  },
                  whatsApp: settings.whatsApp
                    ? {
                        ...settings.whatsApp,
                        isEnabled: false,
                      }
                    : undefined,
                },
              },
            });
            const publishedTypebotSettings = typebot.publishedTypebot
              ?.settings as Settings | null;
            if (
              !publishedTypebotSettings ||
              publishedTypebotSettings?.general?.isBrandingEnabled
            )
              continue;
            await prisma.publicTypebot.updateMany({
              where: { id: typebot.id },
              data: {
                settings: {
                  ...publishedTypebotSettings,
                  general: {
                    ...publishedTypebotSettings.general,
                    isBrandingEnabled: true,
                  },
                },
              },
            });
          }
          return res.send({ message: "workspace downgraded in DB" });
        }
        default: {
          return res.status(304).send({ message: "event not handled" });
        }
      }
    } catch (err) {
      console.error(err);
      if (err instanceof Error) {
        console.error(err);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }
      return res.status(500).send(`Error occured: ${err}`);
    }
  }
  return methodNotAllowed(res);
};
