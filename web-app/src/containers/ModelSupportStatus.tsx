// ModelSupportStatus previously showed GGUF/llamacpp memory-fit indicators.
// llamacpp has been removed from the project, so this component is a no-op.

interface ModelSupportStatusProps {
  modelId: string | undefined
  provider: string | undefined
  contextSize: number
  className?: string
}

export const ModelSupportStatus = ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  modelId: _modelId,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  provider: _provider,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  contextSize: _contextSize,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  className: _className,
}: ModelSupportStatusProps) => {
  return null
}
