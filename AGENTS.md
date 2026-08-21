# AgentCheck — Repository Agent Çalışma Sözleşmesi

## 1. Amaç ve Kapsam

Bu dosya, kullanıcının global `AGENTS.md` kurallarını **tamamlayan repository-seviyesi talimatları** içerir.

- Global kuralları gevşetmez.
- Global güvenlik, yetki ve onay sınırlarını kaldırmaz.
- AgentCheck'e özgü ürün, mimari, kapsam ve doğrulama kurallarını tanımlar.
- Bir kural çelişkili görünüyorsa sessizce yorumlama yapma; daha kısıtlayıcı davranışı seç ve önemliyse kullanıcıya bildir.

Bu repository için kalıcı ürün hedefi:

> AgentCheck, AI destekli yazılım geliştirme sonrasında repository'de ne değiştiğini, neyin şüpheli olduğunu ve commit öncesi nelerin incelenmesi gerektiğini bağımsız olarak gösteren bir doğrulama aracıdır.

AgentCheck başka bir coding agent değildir.

---

## 2. v0.1 Ürün İlkeleri

v0.1 şu özellikleri korumalıdır:

- Basit
- Hızlı
- Local-first
- Güvenilir
- Mümkün olduğunca deterministik
- AI olmadan faydalı
- Kullanılan coding agent'tan bağımsız
- Kolay kurulabilir
- Kolay anlaşılır
- Kolay kaldırılabilir
- Açık kaynak

Ana doğrulama döngüsü:

```text
Coding agent çalışır
        ↓
Agent "done" der
        ↓
Developer AgentCheck çalıştırır
        ↓
Değişiklikleri ve bulguları inceler
        ↓
Commit eder
```

Bir özellik şu soruya yardımcı olmuyorsa büyük olasılıkla v0.1 kapsamına ait değildir:

> "Coding agent işi bitirdiğini söylüyor. Ne değişti, ne şüpheli ve commit etmeden önce neyi incelemeliyim?"

---

## 3. Onaylanmış v0.1 Teknik Yönü

Aşağıdaki kararlar bu repository için **önceden onaylanmış teknik yön** kabul edilir. Bunları uygulamak için yeniden kullanıcı onayı isteme.

### Teknoloji

- TypeScript / Node.js
- Minimum hedef Node.js: `>=22`
- Küçük bir monorepo
- Ortak iş mantığı `@agentcheck/core` içinde
- CLI ve VS Code aynı core paketini kullanır
- CLI ve VS Code için ayrı business logic oluşturulmaz

Beklenen üst seviye yapı:

```text
packages/
  core/
  cli/
  vscode/
```

Yapı ihtiyaç halinde küçük ölçüde iyileştirilebilir; yeni katman/pattern eklemek gerekiyorsa global onay kurallarına uy.

### Checkpoint mimarisi

Checkpoint ve repository karşılaştırma semantiği için `SEMANTICS.md` **source of truth** kabul edilir.

Onaylanmış temel yaklaşım:

- Kendi tam dosya snapshot sistemimizi kurma.
- Git'in tree/index mekanizmasını kullan.
- Developer'ın gerçek Git index'ine dokunma.
- Geçici/alternatif Git index kullan.
- AgentCheck'e ait Git objelerini mümkün olduğunca AgentCheck metadata alanında izole et.
- Working tree'yi değiştirme.
- Stash/reset/checkout/commit gibi destructive veya state-changing Git işlemleri kullanma.
- Dirty working tree ve untracked dosyaları doğru ele al.
- Karşılaştırmayı checkpoint anındaki state ile mevcut state arasında yap.

Bu semantiği değiştirmek yeni bir mimari/persistence kararıdır; kullanıcı onayı olmadan değiştirme.

---

## 4. v0.1 Kapsam Dışı

Açık kullanıcı kararı olmadan aşağıdakileri uygulama:

- Backend
- Veritabanı
- Kullanıcı hesabı
- Login/auth
- Cloud storage
- Telemetry
- Payment/subscription
- LLM veya AI entegrasyonu
- OpenAI/Anthropic entegrasyonu
- Agent-specific API entegrasyonu
- Claude Code/Codex/Cursor'a özel entegrasyon
- Embedding/vector database
- Repository-wide knowledge graph
- GitHub App
- PR bot
- GitHub Actions ürünü
- Team/organization özellikleri
- Enterprise dashboard
- Otomatik code review düzeltmeleri
- Test generation
- Kaynak kodu otomatik değiştirme
- Otomatik fix

v0.1 analiz eder; developer'ın kaynak kodunu değiştirmez.

---

## 5. Uygulama İlkeleri

Her görevde:

1. Önce ilgili mevcut kodu ve dokümanları incele.
2. Görevi karşılayan en küçük tam çözümü uygula.
3. Spekülatif abstraction oluşturma.
4. Sadece olası gelecek ihtiyaçlar için interface/factory/layer ekleme.
5. Strong typing tercih et.
6. Core katmanını VS Code API'sinden bağımsız tut.
7. CLI presentation kodunu core davranışına karıştırma.
8. Analyzer'ları bağımsız test edilebilir tut.
9. Production dependency sayısını düşük tut.
10. Deterministik ve açıklanabilir davranışı tercih et.
11. Hata durumlarında anlaşılır ve güvenli biçimde fail et.
12. Cross-platform path/command davranışını dikkate al.
13. Shell string birleştirmek yerine mümkün olduğunda process argument API'lerini kullan.
14. Kullanıcının gerçek Git index'ini, working tree'sini veya history'sini değiştirme.
15. İlgisiz refactor yapma.

Kodun mevcut basitliği bir değerdir. Daha "kurumsal" görünmesi tek başına abstraction ekleme gerekçesi değildir.

---

## 6. Git Güvenlik Kuralları

AgentCheck'in güvenilirliği repository-state karşılaştırmasına bağlıdır.

Agent:

- `.git` yolunun her zaman fiziksel bir klasör olduğunu varsaymamalıdır.
- Git metadata yollarını mümkün olduğunda Git komutlarıyla çözmelidir.
- Gerçek index üzerinde `git add`, `git reset` veya eşdeğer state-changing işlem çalıştırmamalıdır.
- Snapshot oluşturmak için gerçek index yerine alternatif/geçici index kullanmalıdır.
- Kullanıcının staged değişikliklerini korumalıdır.
- Pre-existing dirty state'i checkpoint'in bir parçası olarak kabul etmelidir.
- Non-ignored untracked dosyaları checkpoint karşılaştırmasına dahil etmelidir.
- Ignored untracked dosyaları v0.1'de kapsam dışında tutmalıdır.
- Rename detection için mümkün olduğunda Git'in kendi mekanizmasını kullanmalıdır.
- Submodule içeriğini recursive analiz etmeye çalışmamalıdır; v0.1'de Git'in gitlink davranışı yeterlidir.

Repository state'i değiştiren yeni bir yaklaşım öneriliyorsa uygulamadan önce kullanıcı onayı gerekir.

---

## 7. Test Stratejisi

Core/checkpoint katmanında testler kritik kabul edilir.

Testlerde mümkün olduğunca geçici gerçek Git repository'leri oluştur ve davranışı uçtan uca doğrula. Sadece mock'larla Git semantiğini kanıtlamaya çalışma.

Checkpoint/diff katmanı için en az şu senaryolar korunmalıdır:

- Clean repository
- Modified tracked file
- Checkpoint öncesinde dirty tracked file
- Checkpoint öncesinde staged change
- Checkpoint öncesinde unstaged change
- Yeni non-ignored untracked file
- Deleted file
- Renamed file
- Boşluk içeren dosya adı
- Detached HEAD
- Checkpoint sonrasında branch değişmesi
- Checkpoint sonrasında HEAD değişmesi
- Repository subdirectory içinden çalışma
- Ignored untracked file'ın raporlanmaması
- Gerçek Git index'inin snapshot işlemi sonrasında değişmemesi

Bir bug Git edge-case'i ile ilgiliyse mümkünse regression test ekle.

Çalıştırmadığın testi geçmiş gibi raporlama.

---

## 8. Değişiklik ve Onay Sınırı

Aşağıdakiler bu repository'de mevcut yönün uygulaması olarak kabul edilir ve görev kapsamındaysa otonom yapılabilir:

- `SEMANTICS.md` ile uyumlu checkpoint implementation
- Core Git wrapper/helper'ları
- Checkpoint persistence
- Tree-to-tree diff
- File change model/parsing
- İlgili unit/integration testleri
- Mevcut onaylı monorepo yapısının oluşturulması
- Görevde açıkça istenmiş analyzer/CLI/VS Code işleri

Aşağıdakilerde global `AGENTS.md` onay kuralları uygulanır:

- `SEMANTICS.md` davranışını değiştirmek
- Farklı checkpoint/snapshot mimarisine geçmek
- Yeni architectural layer/pattern eklemek
- Production dependency eklemek veya değiştirmek
- Public contract'ta görevde tanımlanmamış anlamlı değişiklik yapmak
- v0.1 kapsamını genişletmek
- Repository state'ini değiştiren yeni Git tekniği kullanmak

---

## 9. Çalışma Sırası

Görev checkpoint/core alanındaysa şu sırayı tercih et:

1. İlgili dokümanları oku.
2. Mevcut implementation varsa incele.
3. En küçük tasarımı belirle.
4. Test senaryolarını netleştir.
5. Implementation yap.
6. Focused testleri çalıştır.
7. Gerekirse build/typecheck çalıştır.
8. Diff'i gözden geçir.
9. Sonuçları raporla.

Görev dışındaki modüllere dokunma.

---

## 10. Görev Sonu Raporu

Her anlamlı implementation görevinin sonunda kısa ve doğrulanabilir biçimde raporla:

- Değiştirilen dosyalar
- Uygulanan davranış
- Alınan önemli teknik kararlar
- Çalıştırılan test/build/typecheck komutları
- Sonuçları
- Dokümante edilmiş tasarımdan sapma varsa sapma
- Kalan risk veya belirsizlik

Commit veya push yapma; global kurallar geçerlidir.
