export interface AuthContext {
  staffId: string
  role: string
  storeId: string
  permissions: string[]
}

export interface PaginatedQuery {
  page?: number
  limit?: number
  search?: string
}
