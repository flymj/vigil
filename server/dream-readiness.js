import { providerCredentialStatus } from './config.js'
import { dreamRuntimeCompatibility } from './dream-compatibility.js'
import { dreamScheduleReadiness } from './dream-schedule.js'

export async function dreamOperationalReadiness(settings) {
  const schedule = dreamScheduleReadiness(settings.dreamSchedule, settings.windowSchedule)
  const runtime = dreamRuntimeCompatibility()
  const reasons = [...schedule.reasons, ...runtime.reasons]
  let providerReady = false
  if (!settings.provider?.baseUrl || !settings.provider?.model) {
    reasons.push('Dream requires a configured Provider base URL and model')
  } else {
    try {
      const credential = await providerCredentialStatus(settings)
      providerReady = credential.providerReady
      if (!providerReady) reasons.push('Dream Provider credential is not configured')
    } catch (error) {
      reasons.push(`Dream Provider readiness check failed: ${error?.message || error}`)
    }
  }
  return {
    ready: schedule.ready && runtime.ready && providerReady,
    reasons,
    schedule: schedule.schedule,
    runtime,
    providerReady,
  }
}
