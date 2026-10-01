import { bg, REPLY_TASK, runReplyCheck } from './replyAlerts';

/**
 * The reply-alert background task, defined at module scope as
 * expo-task-manager requires: when Android runs the task with the app
 * closed, the bundle loads without mounting any screen, so the definition
 * cannot wait for a component. index.ts imports this file before the app
 * registers.
 *
 * On a build without the native modules `bg` is null and nothing is
 * defined. runReplyCheck never throws; the executor always reports Success
 * because the native side ignores the result and schedules the next run
 * either way (a Failed result would not retry sooner).
 */
if (bg) {
  try {
    const { BackgroundTask, TaskManager } = bg;
    TaskManager.defineTask(REPLY_TASK, async () => {
      const outcome = await runReplyCheck();
      // Dev builds only: the outcome shows in Metro, so a device test can see why a run skipped.
      if (__DEV__) console.log(`reply check: ${outcome}`);
      return BackgroundTask.BackgroundTaskResult.Success;
    });
  } catch {
    /* not defined: syncReplyAlerts turns the switch off rather than register an undefined task */
  }
}
