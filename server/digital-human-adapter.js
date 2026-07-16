/**
 * Stable boundary for the digital-human contract that is being redesigned.
 * A future Flyclaw adapter only needs to implement these three methods; Vigil
 * does not depend on employee/profile/assignment wire fields.
 */
export class DigitalHumanAdapter {
  async listAvailable() {
    throw new Error('DigitalHumanAdapter.listAvailable() is not implemented')
  }

  async resolveBinding(_bindingRef) {
    throw new Error('DigitalHumanAdapter.resolveBinding() is not implemented')
  }

  async invokeDeepDive(_binding, _input, _repositoryContext) {
    throw new Error('DigitalHumanAdapter.invokeDeepDive() is not implemented')
  }
}

class UnconfiguredDigitalHumanAdapter extends DigitalHumanAdapter {
  async listAvailable() {
    return {
      status: 'unconfigured',
      contract: 'pending',
      digitalHumans: [],
    }
  }

  async resolveBinding(bindingRef) {
    return bindingRef ? { status: 'unavailable', bindingRef } : null
  }

  async invokeDeepDive() {
    throw new Error('数字人适配器尚未接入；请暂时关闭数字人绑定并使用 OpenAI-compatible Provider')
  }
}

export function createDigitalHumanAdapter(_settings) {
  return new UnconfiguredDigitalHumanAdapter()
}
