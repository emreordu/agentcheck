# AgentCheck — Checkpoint Semantiği

## 1. Amaç

Bu doküman AgentCheck v0.1'in checkpoint ve repository-state karşılaştırma davranışını tanımlar.

Bu alan ürünün temel güven sözleşmesidir.

AgentCheck şu soruya doğru cevap verebilmelidir:

> "Checkpoint oluşturduğum andan şu ana kadar Git-visible repository state'inde ne değişti?"

Bu dokümandaki davranışlar v0.1 için normatiftir. Implementation ayrıntıları değişebilir; gözlemlenebilir semantik kullanıcı onayı olmadan değişmemelidir.

---

## 2. Temel Tanımlar

### Checkpoint

`agentcheck start` çalıştırıldığı anda repository'nin AgentCheck tarafından kabul edilen baseline state'idir.

Checkpoint yalnızca `HEAD` değildir.

Checkpoint şu anda var olan Git-visible working-tree durumunu temsil eder:

- `HEAD`
- tracked dosyalardaki staged değişiklikler
- tracked dosyalardaki unstaged değişiklikler
- non-ignored untracked dosyalar
- tracked deletion'lar

Bu nedenle repository checkpoint oluşturulurken dirty olabilir.

### Current Snapshot

AgentCheck review/check çalıştırıldığı anda aynı kurallarla oluşturulan mevcut repository state'idir.

### Change Set

Checkpoint snapshot ile current snapshot arasındaki farktır.

AgentCheck'in temel değişiklik sonucu şunları ifade edebilmelidir:

- modified
- created
- deleted
- renamed, Git tarafından makul şekilde tespit edilebildiğinde

---

## 3. Ana Semantik

En önemli kural:

> Checkpoint öncesinde var olan değişiklikler AgentCheck sonucunda yeni değişiklik gibi raporlanmamalıdır.

Örnek:

```text
HEAD
 │
 ├── OrderService.cs developer tarafından değiştirildi
 │
 └── agentcheck start
          ↓
    CHECKPOINT
          ↓
    Coding agent OrderService.cs'yi tekrar değiştirdi
          ↓
      CURRENT
```

AgentCheck, `HEAD -> CURRENT` farkını değil:

```text
CHECKPOINT -> CURRENT
```

farkını raporlamalıdır.

Dolayısıyla checkpoint öncesindeki dirty değişiklik baseline'ın parçasıdır.

---

## 4. Git Tree Tabanlı Snapshot

v0.1'de tam dosya içeriklerini özel bir `FileSnapshot[]` formatına kopyalayan home-grown snapshot sistemi kullanılmaz.

Tercih edilen model:

```text
Working Tree
    ↓
temporary Git index
    ↓
git write-tree
    ↓
Git tree object
```

Checkpoint metadata, oluşan tree id'sini saklar.

Kavramsal model:

```ts
interface Checkpoint {
  schemaVersion: 1;
  createdAt: string;
  head: string;
  branch: string | null;
  tree: string;
}
```

Bu model gerektiğinde genişletilebilir; v0.1'de gereksiz metadata eklenmemelidir.

---

## 5. Gerçek Git Index'ine Dokunmama

Snapshot oluşturma işlemi developer'ın gerçek Git index'ini değiştirmemelidir.

Örneğin developer checkpoint öncesinde:

```text
M  staged-file.ts
 M unstaged-file.ts
```

durumundaysa snapshot sonrasında gerçek `git status` semantiği aynı kalmalıdır.

Bu nedenle snapshot işlemi alternatif/geçici index kullanmalıdır.

Tercih edilen mekanizma:

```text
GIT_INDEX_FILE=<temporary-index>
```

Snapshot komutları bu alternatif index üzerinde çalıştırılır.

Gerçek index üzerinde snapshot amacıyla `git add`, `git reset` veya eşdeğer state-changing işlem çalıştırılmaz.

---

## 6. AgentCheck Git Objelerinin İzolasyonu

Checkpoint tree ve snapshot sırasında oluşturulan blob/tree objeleri mümkün olduğunca normal repository object store'una gereksiz veri bırakmamalıdır.

Tercih edilen yaklaşım AgentCheck'e ait object directory kullanmaktır.

Kavramsal environment:

```text
GIT_OBJECT_DIRECTORY=<agentcheck-object-directory>
GIT_ALTERNATE_OBJECT_DIRECTORIES=<repository-object-directory>
```

Böylece:

- Mevcut repository objeleri okunabilir.
- Yeni snapshot objeleri AgentCheck alanında tutulabilir.
- Developer'ın commit history'si değişmez.

Implementation `.git`'in her zaman normal fiziksel klasör olduğunu varsaymamalıdır.

Metadata/object path'leri mümkün olduğunda Git'in kendi path-resolution komutlarıyla bulunmalıdır.

Linked worktree gibi geçerli Git düzenleri bozulmamalıdır.

---

## 7. Snapshot Oluşturma Algoritması

Normatif davranış aşağıdaki gibidir.

### 7.1 Repository doğrulama

AgentCheck:

1. Çalışılan path'in bir Git worktree içinde olduğunu doğrular.
2. Repository root'u çözer.
3. Git metadata path'lerini çözer.
4. `HEAD` bilgisini okur.
5. Branch bilgisini okur.

Detached HEAD geçerli bir durumdur:

```text
branch = null
```

### 7.2 Unborn repository

Henüz ilk commit'i olmayan repository v0.1 için zorunlu destek değildir.

`HEAD` resolve edilemiyorsa AgentCheck açık ve anlaşılır hata vermelidir.

Sessiz fallback yapmamalıdır.

### 7.3 Temporary index

Yeni bir temporary index oluşturulur.

Başlangıç state'i:

```text
git read-tree HEAD
```

ile alınır.

Bu komut gerçek index üzerinde çalıştırılmaz.

### 7.4 Working tree'nin index'e yansıtılması

Repository root'ta, temporary index kullanılarak working tree state'i index'e yansıtılır.

Kavramsal işlem:

```text
git add -A -- .
```

Bu işlem:

- tracked modifications
- tracked deletions
- non-ignored untracked additions

durumlarını temporary index'e yansıtmalıdır.

Gerçek index etkilenmemelidir.

### 7.5 Tree oluşturma

Temporary index:

```text
git write-tree
```

ile tree object'e dönüştürülür.

Üretilen tree id snapshot'ın kimliğidir.

---

## 8. Ignored Dosyalar

v0.1 semantiği:

> Git tarafından ignored kabul edilen untracked dosyalar checkpoint veya current snapshot'a dahil edilmez; `.env` ve `.env.*` istisnadır.

Örnek kapsam dışı dosyalar:

```text
node_modules/
bin/
obj/
dist/
coverage/
.env
```

Ancak kesin davranış repository'nin `.gitignore`, global ignore ve Git ignore kurallarına bağlıdır.

Önemli sonuç:

AgentCheck, yalnızca `.env` ve `.env.*` dosyalarını Git'in ignored-path sorgusuyla hedefleyip geçici index'e ekler. Bu dosyalar normal change/analyzer akışına katılır; gerçek Git index'i etkilenmez.

AgentCheck v0.1 ignored directory'leri recursive tarayarak kendi alternatif repository modeli oluşturmamalıdır.

---

## 9. Current Snapshot ve Karşılaştırma

Review/check sırasında current snapshot, checkpoint ile aynı snapshot semantiği kullanılarak oluşturulur.

Karşılaştırma:

```text
checkpoint.tree
      ↓
   Git diff
      ↓
 current.tree
```

şeklindedir.

Tercih edilen çıktı makine tarafından güvenli parse edilebilen Git formatıdır.

Dosya adlarında:

- boşluk
- Unicode
- özel karakter

olabileceği varsayılmalıdır.

Mümkün olduğunda null-delimited (`-z`) Git çıktıları tercih edilmelidir.

---

## 10. Rename Semantiği

v0.1 rename detection için özel bir similarity engine yazmaz.

Git'in kendi rename detection davranışı kullanılır.

Rename tespit edilirse:

```ts
{
  type: "renamed",
  previousPath: "src/OldName.ts",
  path: "src/NewName.ts"
}
```

gibi temsil edilebilir.

Git rename olarak sınıflandırmazsa AgentCheck'in bunu zorla rename kabul etmesi gerekmez.

Bu nedenle rename detection "best effort" kabul edilir.

---

## 11. Before / After Dosya İçeriği

Analyzer'ların gerektiğinde checkpoint ve current içeriklerini okuyabilmesi gerekir.

Semantik:

```ts
interface FileContentProvider {
  readBefore(path: string): Promise<Buffer | null>;
  readAfter(path: string): Promise<Buffer | null>;
}
```

`before` içeriği checkpoint tree'den okunur.

`after` içeriği current snapshot tree'den okunur.

Bu yaklaşım analyzer çalışırken working tree'nin yeniden değişmesi durumunda mümkün olduğunca tutarlı analiz sağlar.

Dosya yoksa `null` dönebilir:

- created file için before `null`
- deleted file için after `null`

Binary içerik desteklenebilir; analyzer'lar text varsaymamalıdır.

---

## 12. Checkpoint Metadata

Checkpoint metadata AgentCheck'e ait Git metadata alanında tutulmalıdır.

Kavramsal path:

```text
<git-path>/agentcheck/checkpoint.json
```

Fiziksel `.git/agentcheck/...` varsayımı hard-code edilmemelidir.

Metadata en az:

```json
{
  "schemaVersion": 1,
  "createdAt": "...",
  "head": "...",
  "branch": "...",
  "tree": "..."
}
```

bilgilerini içerir.

Yazma işlemi mümkün olduğunda atomic yapılmalıdır:

1. temporary file
2. fsync gereksinimi varsa uygun platform davranışı
3. rename/replace

Yarım yazılmış checkpoint normal kabul edilmemelidir.

---

## 13. Mevcut Checkpoint Varken `start`

v0.1 güvenli varsayılanı:

> Aktif checkpoint varsa `agentcheck start` bunu sessizce overwrite etmez.

Komut açık hata/uyarı ile durmalıdır.

Kullanıcı önce checkpoint'i temizlemelidir:

```text
agentcheck clear
```

Gelecekte açık bir `--force` davranışı eklenebilir; v0.1 için gerekli değildir.

Bu kural yanlışlıkla baseline kaybını önler.

---

## 14. `clear` Semantiği

`agentcheck clear` yalnızca AgentCheck'e ait checkpoint state'ini temizler.

Şunlara dokunmaz:

- working tree
- gerçek Git index
- branch
- HEAD
- commit history
- stash
- developer dosyaları

AgentCheck'e özel artık kullanılmayan snapshot objeleri de güvenli biçimde temizlenebilir.

---

## 15. Checkpoint Olmadan Review

Aktif checkpoint yoksa AgentCheck:

- `HEAD`'i otomatik checkpoint kabul etmez.
- Sessiz baseline uydurmaz.
- Açık hata verir.
- Kullanıcıyı `agentcheck start` çalıştırmaya yönlendirir.

AgentCheck'in sonucu her zaman tanımlı bir checkpoint'e dayanmalıdır.

---

## 16. HEAD veya Branch Değişirse

Checkpoint şu bilgileri saklar:

```text
head
branch
```

Checkpoint sonrasında developer:

- commit atabilir
- branch değiştirebilir
- detached HEAD'e geçebilir
- başka bir commit'e checkout yapabilir

v0.1 semantiği:

> Checkpoint tree hâlâ geçerliyse AgentCheck baseline'ı otomatik değiştirmez.

Karşılaştırma yine:

```text
checkpoint.tree -> current.tree
```

olarak yapılabilir.

Ancak context değişikliği açıkça tespit edilebilmelidir:

```text
headChanged: true
branchChanged: true
```

CLI/analyzer daha sonra bunu warning olarak gösterebilir.

AgentCheck bu durumda sessizce `HEAD -> current` karşılaştırmasına geçmemelidir.

---

## 17. Submodule Semantiği

v0.1 submodule repository'lerinin içine recursive girip ayrı snapshot oluşturmaz.

Parent repository'nin Git tarafından görülen gitlink state'i esas alınır.

Submodule içindeki dirty working-tree değişikliklerinin tamamını analiz etmek v0.1 kapsamı dışındadır.

Bu limitation açık ve deterministik kalmalıdır.

---

## 18. Git LFS

AgentCheck v0.1 Git LFS objelerini fetch etmeye çalışmaz.

Repository'de Git'in gördüğü tracked pointer/content semantiği esas alınır.

Network gerektiren implicit davranış eklenmez.

---

## 19. Repository'yi Değiştirmeme Garantisi

Checkpoint veya review işlemi sırasında AgentCheck aşağıdaki işlemleri kaynak state'i değiştirmek için kullanmamalıdır:

```text
git commit
git reset
git checkout
git switch
git stash
git clean
git merge
git rebase
git cherry-pick
```

Snapshot oluşturmak için developer'ın gerçek index'inde `git add` da kullanılmaz.

AgentCheck'in kendi metadata/object alanını yazması bu garantinin istisnasıdır; application source state'i değildir.

---

## 20. Concurrency Limitation

Filesystem snapshot işlemi tam anlamıyla atomic değildir.

Snapshot alınırken başka bir process aynı anda dosyaları değiştiriyorsa Git komutlarının gözlemlediği state değişebilir.

v0.1:

- Bu problemi özel filesystem locking sistemiyle çözmeye çalışmaz.
- Git hata verirse hatayı saklamaz.
- Sessizce "tam atomik snapshot" garantisi vermez.

İleride gerçek kullanımda sorun oluşturduğu kanıtlanırsa ayrıca ele alınır.

---

## 21. Temel Veri Modeli

Önerilen minimal modeller:

```ts
export interface Checkpoint {
  schemaVersion: 1;
  createdAt: string;
  head: string;
  branch: string | null;
  tree: string;
}
```

```ts
export type FileChangeType =
  | "modified"
  | "created"
  | "deleted"
  | "renamed";

export interface FileChange {
  type: FileChangeType;
  path: string;
  previousPath?: string;
}
```

```ts
export interface ChangeSet {
  files: FileChange[];
}
```

Gereksiz ek domain modelleri v0.1'de oluşturulmamalıdır.

---

## 22. Zorunlu Acceptance Senaryoları

Checkpoint motoru tamamlanmış kabul edilmeden önce en az şu davranışlar doğrulanmalıdır.

### Senaryo A — Clean repository

```text
agentcheck start
modify A.ts
agentcheck
```

Beklenen:

```text
M A.ts
```

### Senaryo B — Pre-existing dirty change

```text
modify A.ts        # developer değişikliği
agentcheck start
modify A.ts        # agent değişikliği
agentcheck
```

Beklenen:

- A.ts modified görünür.
- Diff yalnızca checkpoint sonrası farkı temsil eder.
- Checkpoint öncesindeki değişiklik yeni değişiklik gibi değerlendirilmez.

### Senaryo C — Pre-existing staged change

```text
modify A.ts
git add A.ts
agentcheck start
modify B.ts
agentcheck
```

Beklenen:

- Developer'ın gerçek staged state'i korunur.
- A.ts yalnızca checkpoint sonrasında değişmediyse AgentCheck değişikliği olarak görünmez.
- B.ts görünür.

### Senaryo D — Untracked file

```text
agentcheck start
create B.ts
agentcheck
```

Beklenen:

```text
A B.ts
```

### Senaryo E — Deleted file

```text
agentcheck start
delete C.ts
agentcheck
```

Beklenen:

```text
D C.ts
```

### Senaryo F — Rename

```text
agentcheck start
rename D.ts -> E.ts
agentcheck
```

Git rename tespit ederse beklenen:

```text
R D.ts -> E.ts
```

### Senaryo G — Ignored file

```text
agentcheck start
create ignored-file
agentcheck
```

Beklenen:

Ignored untracked file change set'e girmez.

### Senaryo H — Gerçek index korunur

Snapshot öncesi ve sonrası gerçek index state'i eşdeğer olmalıdır.

Bu test kritik kabul edilir.

### Senaryo I — Branch/HEAD değişimi

Checkpoint sonrası branch veya HEAD değişirse:

- baseline silently reset edilmez
- tree-to-tree comparison korunur
- context değişikliği tespit edilebilir

---

## 23. M1 Tamamlanma Kriteri

İlk milestone:

> AgentCheck, repository checkpoint state'ini güvenilir biçimde yakalayabilir ve daha sonra yalnızca checkpoint sonrasında oluşan Git-visible değişiklikleri raporlayabilir.

M1 tamamlandığında analyzer implementasyonu henüz gerekli değildir.

Örnek:

```text
1. A.cs checkpoint öncesi modify edilmiş
2. agentcheck start
3. A.cs tekrar modify edilmiş
4. B.cs oluşturulmuş
5. C.cs silinmiş
6. D.cs -> E.cs rename edilmiş
7. agentcheck
```

Beklenen özet:

```text
1 modified
1 created
1 deleted
1 renamed
```

ve AgentCheck developer'ın checkpoint öncesindeki A.cs değişikliğini yeni değişiklik olarak raporlamamalıdır.

Bu garanti sağlanmadan analyzer, risk scoring veya VS Code katmanına güvenilmez.
