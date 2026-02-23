import type { Context } from 'hono';
import type {
  Bindings,
  LinearWebhook,
  LinearAgentSessionWebhook,
  LinearUnassignWebhook,
} from '../types';
import { verifyLinearSignature } from '../utils/crypto';
import * as db from '../db/queries';
import { handleSessionCreated } from './session-created';
import { handleSessionPrompted } from './session-prompted';
import { handleInboxNotification } from './inbox-notification';

/**
 * Main Linear webhook handler
 * Routes webhooks to appropriate handlers based on type and action
 */
export async function handleLinearWebhook(
  c: Context<{ Bindings: Bindings }>
): Promise<Response> {
  const body = await c.req.text();
  const signature = c.req.header('linear-signature') || '';

  // Verify webhook signature
  const isValid = await verifyLinearSignature(
    body,
    signature,
    c.env.LINEAR_WEBHOOK_SECRET
  );

  if (!isValid) {
    console.error('Invalid Linear webhook signature');
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const payload = JSON.parse(body) as LinearWebhook;

  // Generate webhook ID for idempotency
  const webhookId = generateWebhookId(payload);

  // Check if already processed
  const isProcessed = await db.isWebhookProcessed(c.env.DB, webhookId, 'linear');
  if (isProcessed) {
    console.log(`Webhook ${webhookId} already processed, skipping`);
    return c.json({ status: 'already_processed' });
  }

  // Mark as processed (before handling to prevent duplicates)
  await db.markWebhookProcessed(c.env.DB, webhookId, 'linear');

  try {
    // Route based on webhook type
    if (isAgentSessionWebhook(payload)) {
      if (payload.action === 'created') {
        await handleSessionCreated(c, payload);
      } else if (payload.action === 'prompted') {
        await handleSessionPrompted(c, payload);
      }
    } else if (isUnassignWebhook(payload)) {
      await handleInboxNotification(c, payload);
    } else {
      console.log('Unhandled Linear webhook type:', (payload as { type: string }).type);
    }

    return c.json({ status: 'ok' });
  } catch (error) {
    console.error('Error handling Linear webhook:', error);
    // Log error to database for debugging
    try {
      const sessionId = isAgentSessionWebhook(payload)
        ? payload.agentSession.id
        : undefined;
      await db.logEvent(c.env.DB, {
        agentSessionId: sessionId,
        eventType: 'webhook_error',
        message: `Error handling ${payload.type}/${(payload as { action?: string }).action}: ${String(error)}`,
      });
    } catch {
      // Don't let error logging failure mask the original error
    }
    // Still return 200 to prevent retries - we've already marked as processed
    return c.json({ status: 'error', message: String(error) });
  }
}

/**
 * Type guard for AgentSessionEvent webhooks
 */
function isAgentSessionWebhook(
  payload: LinearWebhook
): payload is LinearAgentSessionWebhook {
  return payload.type === 'AgentSessionEvent';
}

/**
 * Type guard for unassign webhooks
 */
function isUnassignWebhook(
  payload: LinearWebhook
): payload is LinearUnassignWebhook {
  return (
    payload.type === 'AppUserNotification' &&
    payload.action === 'issueUnassignedFromYou'
  );
}

/**
 * Generate a unique ID for deduplication
 */
function generateWebhookId(payload: LinearWebhook): string {
  if (isAgentSessionWebhook(payload)) {
    // For prompted events, include the activity ID to allow multiple prompts
    if (payload.action === 'prompted' && payload.agentActivity?.id) {
      return `linear-session-${payload.agentSession.id}-prompted-${payload.agentActivity.id}`;
    }
    return `linear-session-${payload.agentSession.id}-${payload.action}`;
  } else if (isUnassignWebhook(payload)) {
    return `linear-unassign-${payload.notification.issue.id}-${Date.now()}`;
  }
  return `linear-unknown-${Date.now()}`;
}
