import { Hono } from 'hono';
import {
  NONE_ENTITLEMENT,
  successResponse,
  errorResponse,
} from '@sudobility/types';
import { requireAuth, type AuthUser } from '../middleware/auth';
import { getSubscriptionHelper, getTestMode } from '../middleware/subscription';
import type {
  SubscriptionStatusResponse,
  MixrErrorResponse,
} from '@sudobility/mixr_types';

type Variables = {
  user: AuthUser;
};

const app = new Hono<{ Variables: Variables }>();

/**
 * GET /api/v1/users/:userId/subscriptions
 *
 * Get user subscription status (requires Firebase auth).
 */
app.get('/:userId/subscriptions', requireAuth, async c => {
  const requestedUserId = c.req.param('userId');
  const authUser = c.get('user') as AuthUser;

  if (authUser.uid !== requestedUserId) {
    return c.json<MixrErrorResponse>(
      errorResponse('You can only access your own subscription'),
      403
    );
  }

  const subHelper = getSubscriptionHelper();
  if (!subHelper) {
    return c.json<MixrErrorResponse>(
      errorResponse('Subscription service not configured'),
      500
    );
  }

  try {
    const testMode = getTestMode(c);
    const subscriptionInfo = await subHelper.getSubscriptionInfo(
      requestedUserId,
      testMode
    );
    return c.json<SubscriptionStatusResponse>(
      successResponse({
        hasSubscription:
          subscriptionInfo.entitlements.length > 0 &&
          !subscriptionInfo.entitlements.includes(NONE_ENTITLEMENT),
        entitlements: subscriptionInfo.entitlements,
        subscriptionStartedAt: subscriptionInfo.subscriptionStartedAt,
        platform: subscriptionInfo.platform,
      })
    );
  } catch (error) {
    console.error('Error fetching subscription:', error);
    return c.json<MixrErrorResponse>(
      errorResponse('Failed to fetch subscription status'),
      500
    );
  }
});

export default app;
