/** Строковый идентификатор с compile-time маркером доменного типа. */
export type BrandedId<Brand extends string> = string & { readonly __brand: Brand };

/** Идентификатор актива. */
export type AssetId = BrandedId<'AssetId'>;
/** Идентификатор торгового или пользовательского счёта. */
export type AccountId = BrandedId<'AccountId'>;
/** Идентификатор проводки. */
export type PostingId = BrandedId<'PostingId'>;
/** Идентификатор идемпотентной операции. */
export type OperationId = BrandedId<'OperationId'>;

/** Создаёт проверенный typed ID из непустой строки. */
export function createId<Brand extends string>(value: string): BrandedId<Brand> {
  if (value.trim() === '') {
    throw new Error('ID must not be empty');
  }
  return value as BrandedId<Brand>;
}
