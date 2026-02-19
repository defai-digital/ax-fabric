/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useSearch } from '@tanstack/react-router'
import ChatInput from '@/containers/ChatInput'
import HeaderPage from '@/containers/HeaderPage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useTools } from '@/hooks/useTools'
import { cn } from '@/lib/utils'

import { useModelProvider } from '@/hooks/useModelProvider'
import SetupScreen from '@/containers/SetupScreen'
import { route } from '@/constants/routes'
import { localStorageKey } from '@/constants/localStorage'

type SearchParams = {
  'model'?: {
    id: string
    provider: string
  }
}
import { useEffect, useState } from 'react'
import { useThreads } from '@/hooks/useThreads'
import DropdownModelProvider from '@/containers/DropdownModelProvider'

export const Route = createFileRoute(route.home as any)({
  component: Index,
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const result: SearchParams = {
      model: search.model as SearchParams['model'],
    }

    return result
  },
})

function Index() {
  const { t } = useTranslation()
  const { providers } = useModelProvider()
  const search = useSearch({ from: route.home as any })
  const selectedModel = search.model
  const { setCurrentThreadId } = useThreads()
  useTools()

  // Track setup completion in React state so the component re-renders when the
  // user completes setup (navigating to the same route would not trigger a re-render).
  const [setupCompleted, setSetupCompleted] = useState(
    () => localStorage.getItem(localStorageKey.setupCompleted) === 'true'
  )

  const hasValidProviders =
    setupCompleted ||
    providers.some((provider) => Boolean(provider.api_key?.length))

  useEffect(() => {
    setCurrentThreadId(undefined)
  }, [setCurrentThreadId])

  if (!hasValidProviders) {
    return <SetupScreen onComplete={() => setSetupCompleted(true)} />
  }

  return (
    <div className="flex h-full flex-col justify-center">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <DropdownModelProvider model={selectedModel} />
        </div>
      </HeaderPage>
      <div
        className={cn(
          'h-full overflow-y-auto inline-flex flex-col gap-2 justify-center px-3'
        )}
      >
        <div
          className={cn(
            'mx-auto w-full md:w-4/5 xl:w-4/6 -mt-20',
          )}
        >
          <div className={cn('text-center mb-4')}>
            <h1
              className={cn(
                'text-2xl mt-2 font-studio font-medium',
              )}
            >
              {t('chat:description')}
            </h1>
          </div>
          <div className="flex-1 shrink-0">
            <ChatInput
              showSpeedToken={false}
              model={selectedModel}
              initialMessage={true}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
