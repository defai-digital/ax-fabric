/**
 * Default Models Service - Web implementation
 */

import { sanitizeModelId } from '@/lib/utils'
import {
  modelInfo,
  ThreadMessage,
  events,
  DownloadEvent,
  UnloadResult,
} from '@ax-fabric/core'
import { Model as CoreModel } from '@ax-fabric/core'
import type {
  ModelsService,
  ModelCatalog,
  HuggingFaceRepo,
  CatalogModel,
  ModelValidationResult,
} from './types'

export class DefaultModelsService implements ModelsService {
  async getModel(_modelId: string): Promise<modelInfo | undefined> {
    return undefined
  }

  async fetchModels(): Promise<modelInfo[]> {
    return []
  }

  async fetchModelCatalog(): Promise<ModelCatalog> {
    try {
      const response = await fetch(MODEL_CATALOG_URL)

      if (!response.ok) {
        throw new Error(
          `Failed to fetch model catalog: ${response.status} ${response.statusText}`
        )
      }

      const catalog: ModelCatalog = await response.json()
      return catalog
    } catch (error) {
      console.error('Error fetching model catalog:', error)
      throw new Error(
        `Failed to fetch model catalog: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  async fetchHuggingFaceRepo(
    repoId: string,
    hfToken?: string
  ): Promise<HuggingFaceRepo | null> {
    try {
      // Clean the repo ID to handle various input formats
      const cleanRepoId = repoId
        .replace(/^https?:\/\/huggingface\.co\//, '')
        .replace(/^huggingface\.co\//, '')
        .replace(/\/$/, '') // Remove trailing slash
        .trim()

      if (!cleanRepoId || !cleanRepoId.includes('/')) {
        return null
      }

      const response = await fetch(
        `https://huggingface.co/api/models/${cleanRepoId}?blobs=true&files_metadata=true`,
        {
          headers: hfToken
            ? {
                Authorization: `Bearer ${hfToken}`,
              }
            : {},
        }
      )

      if (!response.ok) {
        if (response.status === 404) {
          return null // Repository not found
        }
        throw new Error(
          `Failed to fetch HuggingFace repository: ${response.status} ${response.statusText}`
        )
      }

      const repoData = await response.json()
      return repoData
    } catch (error) {
      console.error('Error fetching HuggingFace repository:', error)
      return null
    }
  }

  convertHfRepoToCatalogModel(repo: HuggingFaceRepo): CatalogModel {
    // Format file size helper
    const formatFileSize = (size?: number) => {
      if (!size) return 'Unknown size'
      if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`
      return `${(size / 1024 ** 3).toFixed(1)} GB`
    }

    // Extract GGUF files from the repository siblings
    const ggufFiles =
      repo.siblings?.filter((file) =>
        file.rfilename.toLowerCase().endsWith('.gguf')
      ) || []

    // Separate regular GGUF files from mmproj files
    const regularGgufFiles = ggufFiles.filter(
      (file) => !file.rfilename.toLowerCase().includes('mmproj')
    )

    const mmprojFiles = ggufFiles.filter((file) =>
      file.rfilename.toLowerCase().includes('mmproj')
    )

    // Convert regular GGUF files to quants format
    const quants = regularGgufFiles.map((file) => {
      // Generate model_id from filename (remove .gguf extension, case-insensitive)
      const modelId = file.rfilename.replace(/\.gguf$/i, '')

      return {
        model_id: `${repo.author}/${sanitizeModelId(modelId)}`,
        path: `https://huggingface.co/${repo.modelId}/resolve/main/${file.rfilename}`,
        file_size: formatFileSize(file.size),
      }
    })

    // Convert mmproj files to mmproj_models format
    const mmprojModels = mmprojFiles.map((file) => {
      const modelId = file.rfilename.replace(/\.gguf$/i, '')

      return {
        model_id: sanitizeModelId(modelId),
        path: `https://huggingface.co/${repo.modelId}/resolve/main/${file.rfilename}`,
        file_size: formatFileSize(file.size),
      }
    })

    // Extract safetensors files
    const safetensorsFiles =
      repo.siblings?.filter((file) =>
        file.rfilename.toLowerCase().endsWith('.safetensors')
      ) || []

    // Check if this repository has MLX model files (safetensors + associated files)
    const hasMlxFiles =
      repo.library_name === 'mlx' || repo.tags?.includes('mlx')

    const safetensorsModels = safetensorsFiles.map((file) => {
      // Generate model_id from filename (remove .safetensors extension, case-insensitive)
      const modelId = file.rfilename.replace(/\.safetensors$/i, '')

      return {
        model_id: sanitizeModelId(modelId),
        path: `https://huggingface.co/${repo.modelId}/resolve/main/${file.rfilename}`,
        file_size: formatFileSize(file.size),
        sha256: file.lfs?.sha256,
      }
    })

    return {
      model_name: repo.modelId,
      developer: repo.author,
      downloads: repo.downloads || 0,
      created_at: repo.createdAt,
      num_quants: quants.length,
      quants: quants,
      num_mmproj: mmprojModels.length,
      mmproj_models: mmprojModels,
      safetensors_files: safetensorsModels,
      num_safetensors: safetensorsModels.length,
      is_mlx: hasMlxFiles,
      readme: `https://huggingface.co/${repo.modelId}/resolve/main/README.md`,
      description: `**Tags**: ${repo.tags?.join(', ')}`,
    }
  }

  async updateModel(modelId: string, model: Partial<CoreModel>): Promise<void> {
    // Note: Model name/ID updates are handled at the provider level in the frontend
    console.log('Model update request processed for modelId:', modelId, model)
  }

  async pullModel(
    _id: string,
    _modelPath: string,
    _modelSha256?: string,
    _modelSize?: number,
    _mmprojPath?: string,
    _mmprojSha256?: string,
    _mmprojSize?: number
  ): Promise<void> {
    // Local model download not supported without llamacpp/mlx engines
    console.warn('pullModel: local model download is not supported')
  }

  async pullModelWithMetadata(
    id: string,
    modelPath: string,
    mmprojPath?: string,
    hfToken?: string,
    skipVerification: boolean = true
  ): Promise<void> {
    let modelSha256: string | undefined
    let modelSize: number | undefined
    let mmprojSha256: string | undefined
    let mmprojSize: number | undefined

    // Extract repo ID from model URL
    // URL format: https://huggingface.co/{repo}/resolve/main/{filename}
    const modelUrlMatch = modelPath.match(
      /https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/main\/(.+)/
    )

    if (modelUrlMatch && !skipVerification) {
      const [, repoId, modelFilename] = modelUrlMatch

      try {
        // Fetch real-time metadata from HuggingFace
        const repoInfo = await this.fetchHuggingFaceRepo(repoId, hfToken)

        if (repoInfo?.siblings) {
          // Find the specific model file
          const modelFile = repoInfo.siblings.find(
            (file) => file.rfilename === modelFilename
          )
          if (modelFile?.lfs) {
            modelSha256 = modelFile.lfs.sha256
            modelSize = modelFile.lfs.size
          }

          // If mmproj path provided, extract its metadata too
          if (mmprojPath) {
            const mmprojUrlMatch = mmprojPath.match(
              /https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/main\/(.+)/
            )
            if (mmprojUrlMatch) {
              const [, mmprojFilename] = mmprojUrlMatch
              const mmprojFile = repoInfo.siblings.find(
                (file) => file.rfilename === mmprojFilename
              )
              if (mmprojFile?.lfs) {
                mmprojSha256 = mmprojFile.lfs.sha256
                mmprojSize = mmprojFile.lfs.size
              }
            }
          }
        }
      } catch (error) {
        console.warn(
          'Failed to fetch HuggingFace metadata, proceeding without hash verification:',
          error
        )
      }
    }

    // Call the original pullModel with the fetched metadata
    return this.pullModel(
      id,
      modelPath,
      modelSha256,
      modelSize,
      mmprojPath,
      mmprojSha256,
      mmprojSize
    )
  }

  async abortDownload(id: string): Promise<void> {
    try {
      // No local engines available; just emit the stopped event
    } finally {
      events.emit(DownloadEvent.onFileDownloadStopped, {
        modelId: id,
        downloadType: 'Model',
      })
    }
  }

  async deleteModel(_id: string, _provider?: string): Promise<void> {
    // Local model deletion not supported without llamacpp/mlx engines
    console.warn('deleteModel: local model deletion is not supported')
  }

  async getActiveModels(_provider?: string): Promise<string[]> {
    return []
  }

  async stopModel(
    _model: string,
    _provider?: string
  ): Promise<UnloadResult | undefined> {
    return undefined
  }

  async stopAllModels(): Promise<void> {
    // No local engines to stop
  }

  async startModel(
    _provider: ProviderObject,
    _model: string,
    _bypassAutoUnload: boolean = false
  ): Promise<undefined> {
    // Local model start not supported without llamacpp/mlx engines
    console.warn('startModel: local model start is not supported')
    return undefined
  }

  async isToolSupported(_modelId: string): Promise<boolean> {
    return false
  }

  async checkMmprojExistsAndUpdateOffloadMMprojSetting(
    _modelId: string,
    _updateProvider?: (
      providerName: string,
      data: Partial<ModelProvider>
    ) => void,
    _getProviderByName?: (providerName: string) => ModelProvider | undefined
  ): Promise<{ exists: boolean; settingsUpdated: boolean }> {
    return { exists: false, settingsUpdated: false }
  }

  async checkMmprojExists(_modelId: string): Promise<boolean> {
    return false
  }

  async isModelSupported(
    _modelPath: string,
    _ctxSize?: number
  ): Promise<'RED' | 'YELLOW' | 'GREEN' | 'GREY'> {
    return 'GREY'
  }

  async validateGgufFile(_filePath: string): Promise<ModelValidationResult> {
    return {
      isValid: false,
      error: 'Local model validation not supported',
    }
  }

  async getTokensCount(
    _modelId: string,
    _messages: ThreadMessage[]
  ): Promise<number> {
    return 0
  }

}
