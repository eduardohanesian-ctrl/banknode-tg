# BankNode Ethereum Threshold ECDSA V1

Три взаимодействующих процесса Node.js образуют один Ethereum EOA и выпускают
обычную recoverable secp256k1 ECDSA-подпись только при участии любых двух из
трёх узлов. Полный приватный ключ не создаётся ни во время DKG, ни при подписи.

Интерфейс и компоновка повторяют Bitcoin-проект:

- `three-headed-bot.js` — entry point, peer HTTP(S), DKG/sign orchestration;
- `crypto_backend.js` — криптографический backend;
- `tg_backend.js` — Telegram polling, команды и approval flow;
- `node-{1,2,3}.config.example.json` — конфигурации в формате BTC-версии;
- `data/` — локальная секретная доля каждого узла.

`crypto_backend.js`, `tg_backend.js` и `three-headed-bot.js` содержат полную реализацию.

## Криптографическая модель

- DKG: три участника независимо создают вклад secp256k1, Shamir 2-of-3 share,
  Feldman VSS commitment и 3072-битный Paillier key pair.
- Threshold signing: исправленная BitGo GG18-схема с MtA, Paillier modulus
  challenge, range proofs, Schnorr proof владения долей и проверяемыми
  commitment/decommitment этапами `V/A` и `U/T`.
- Результат: стандартная Ethereum low-S подпись `r || s || yParity`; её можно
  проверить `ethers.recoverAddress`, geth или любым EVM-инструментом.
- Все transaction digest подписываются как готовые 32 байта без повторного
  SHA-256. `/sign` и `/multisign` сначала применяют EIP-191 `hashMessage`.
- `/send` и `/multisend` строят EIP-1559 transaction, оценивают gas, threshold-
  подписывают `unsignedHash`, локально проверяют recovered address и только
  после этого передают raw transaction RPC-узлу.
- `/tokensend` и `/multitokensend` аналогично формируют ERC-20
  `transfer(address,uint256)` с `value = 0`, проверяют код контракта, `decimals`,
  token balance, результат предварительной симуляции и наличие ETH для gas.

Как и в BTC-версии, публичный вклад каждого узла детерминированно выводится из
`crypto.masterSeed_fix`, Telegram wallet key и фиксированных параметров через
HMAC-SHA512. Поэтому удаление БД и повторный DKG с теми же `_fix`-полями
воспроизводит тот же Ethereum-адрес. Paillier keys, Shamir polynomials и signing
nonces по-прежнему создаются системным CSPRNG и при каждом запуске различаются.
Потеря одного файла доли допустима, потеря любых двух требует повторного DKG.

## Лицензия и коммерческое использование

Код проекта — MIT. Криптографическая связка также MIT:

- `@bitgo/sdk-core@38.4.0`;
- `@bitgo/sdk-lib-mpc@8.33.0`, принудительно закреплён через `overrides`;
- `ethers@6.17.0`.

В dependency graph нет Silence Laboratories, Safeheron и Go-кода. Не удаляйте
`overrides`: новые BitGo MPC-пакеты могут подтянуть DKLS с иной лицензией.
См. `THIRD_PARTY_NOTICES.md` и `npm ls`.

MIT разрешает коммерческое использование, модификацию и распространение при
сохранении copyright/license notice. Это техническая информация, не
индивидуальная юридическая консультация.

## Установка

Требуется Node.js 20+.

```bash
npm ci
npm run check
npm test
```

Полный тест создаёт настоящие 3072-битные Paillier keys трёх сторон и выполняет
полную 2-of-3 Ethereum-подпись. Для ускорения только auxiliary RSA modulus в
тесте равен 512 бит; runtime всегда вызывает `generateNtilde(3072)`.

Все параметры и секреты задаются непосредственно в `node-*.config.json`; переменные
окружения не используются. Скопируйте соответствующий `.config.example.json` в
`.config.json` и замените значения `PASTE_*` и `REPLACE_*`.

В каждом конфиге также заполните `telegram.botToken`, `telegram.allowedGroupId`,
уникальный `crypto.masterSeed_fix` длиной не менее 32 байт и
`ethereum.providers[].baseUrl` уже содержат три публичных Ethereum Mainnet RPC;
провайдеры используются по порядку с автоматическим переключением при сбое.
`http.tls.certPem` и `http.tls.keyPem` принимают либо PEM-текст прямо в JSON,
либо путь относительно конфига. Для production установите
`runtime.environment` в `production` — тогда TLS становится обязательным.
В режиме `development` межузловой HTTPS принимает self-signed сертификаты, как
BTC-версия. В `production` сертификат всегда проверяется системным хранилищем CA.

Для локальной проверки примеры слушают loopback HTTP. Для production:

1. Разместите узлы на разных машинах и security domains.
2. Заполните `http.tls.certPem` и `http.tls.keyPem`.
3. Используйте peer URL `https://...` и сертификаты от доверенного системой CA.
4. Не ставьте `rejectUnauthorized: false`: production validation это запретит.
5. Храните `data/*.db` на зашифрованном диске с отдельными backup/ACL.
6. Установите `runtime.environment` в `production` и используйте фиксированный `package-lock.json`.

Запуск:

```bash
npm start -- node-1.config.example.json
npm start -- node-2.config.example.json
npm start -- node-3.config.example.json
```

Peer-порты Ethereum-версии по умолчанию: `6661`, `6662`, `6663`.

Во время `/create`, после проверки DKG transcript, все три узла параллельно
создают многоразовые 3072-битные параметры `Ntilde` и сохраняют их в локальных
БД. Поэтому `/create` выполняется дольше, зато генерация safe primes больше не
задерживает первую подпись. Повторный `/create` для существующего кошелька не
запускает DKG заново, а только проверяет наличие параметров на всех трёх узлах.

Telegram-ответ `/create` показывает полное время и время подготовки `Ntilde` для
каждого узла в миллисекундах. `generated` означает создание и сохранение новых
параметров, `cached` — проверку и использование сохранённых. Время отдельных
узлов складывать не нужно: вычисления выполняются параллельно.

Для всех межузловых этапов `/create` используется setup timeout 60 минут, чтобы
3072-битная генерация Paillier и `Ntilde` успевала завершиться на слабых
процессорах. У обычных signing-запросов сохраняются более короткие таймауты.

Для Telegram `sendMessage` используется клиентский timeout 10 минут, чтобы
CPU-intensive MPC-раунды не превращали уже доставленное подтверждение в ложную
ошибку команды. Ошибка доставки ответа логируется отдельно и не меняет результат
уже завершённой подписи или broadcast-операции.

Для подробных консольных таймингов Ethereum RPC, approval, peer-запросов,
challenge processing и MPC signing rounds установите `runtime.logLevel` в
`debug` во всех трёх конфигах и перезапустите процессы. Поддерживаемые уровни:
`debug`, `info`, `warn`, `error`, `fatal`; в примерах по умолчанию используется
`info`.

## Telegram-команды

Команды принимаются только из `allowedGroupId` и должны быть адресованы боту.

```text
/create@bot
/create@bot <user_id2> <user_id3>
/address@bot
/balance@bot [address]
/tokenbalance@bot <token_contract> [owner]
/usdtbalance@bot [owner]
/utxo@bot
/status@bot
/sign@bot <message>
/signhash@bot <32-byte-hex>
/send@bot <to> <amount_wei> [max_fee_gwei]
/tokensend@bot <token_contract> <to> <amount_tokens> [max_fee_gwei]
/usdtsend@bot <to> <amount_usdt> [max_fee_gwei]
/multisign@bot <id2> <id3> <message>
/multisignhash@bot <id2> <id3> <32-byte-hex>
/multisend@bot <id2> <id3> <to> <amount_wei> [max_fee_gwei]
/multitokensend@bot <id2> <id3> <token_contract> <to> <amount_tokens> [max_fee_gwei]
/usdtmultisend@bot <id2> <id3> <to> <amount_usdt> [max_fee_gwei]
/approve@bot
/reject@bot
```

Как и в BTC-версии, `user_id2` и `user_id3` могут совпадать между собой или с
ID инициатора; дубликаты сохраняются в каноническом ключе группы.

Для `/send` и `/multisend` значение `amount_wei = 0` включает режим send-all.
Система берёт pending balance и подписывает фактическую сумму
`balance - gasLimit * maxFeePerGas`, то есть резервирует максимальную возможную
комиссию EIP-1559. Если фактический `effectiveGasPrice` окажется ниже
`maxFeePerGas`, неиспользованная часть резерва останется на исходном адресе после
майнинга; поэтому итоговый баланс может быть ненулевым.

`amount_tokens` задаётся в отображаемых единицах токена, например `1.25` для
токена с шестью знаками после запятой. Backend получает `decimals()` из контракта
и без вычислений с плавающей точкой преобразует сумму в целые base units.
`/tokenbalance` и `/usdtbalance` без `owner` выводят баланс личного threshold-
адреса и всех групповых кошельков, в которые входит пользователь. Личный адрес
показывается первым. С явно указанным `owner` проверяется только этот адрес.

Команды `/usdtbalance`, `/usdtsend` и `/usdtmultisend` — безопасные алиасы для
Ethereum Mainnet USDT по фиксированному официальному адресу
`0xdAC17F958D2ee523a2206206994597C13D831ec7`. Они работают только при
`ethereum.chainId = 1`; адрес токена пользователь передать или подменить не может.

`/utxo` сохранён ради совместимости интерфейса и возвращает Ethereum nonce и
balance, поскольку у account-based Ethereum нет UTXO.

`/balance` без адреса выводит сначала personal wallet, затем все group wallets,
в списке участников которых присутствует запросивший Telegram-пользователь. Для
каждого кошелька показываются адрес и ETH-баланс. `/balance <address>` проверяет
только явно указанный Ethereum-адрес.

Перед каждым подписанием второй signer публикует digest и описание операции.
В personal mode инициатор подтверждает или отклоняет её на боте второго узла.
В group mode один из двух дополнительных Telegram ID должен подтвердить;
отклонение заменено timeout, как в исходном интерфейсе.

Явный `/reject` в personal mode окончателен для этой транзакции: coordinator
немедленно останавливается и не обращается к следующему signer. Автоматический
fallback разрешён только если первый signer недоступен, peer-запрос завершился
по timeout или истёк approval timeout. Протокольные ошибки и ошибки валидации
также останавливают операцию без нового запроса approval.

## Сетевой протокол и хранение

Формат peer-настроек совпадает с BTC-версией: `index_fix`, `id`, `ip`, `port`.
Peer определяется заголовками protocol/node ID; отдельной HMAC-аутентификации
на уровне приложения нет. В production межузловые порты необходимо закрыть
сетевым ACL только для адресов участников и использовать HTTPS с сертификатами
от доверенного системного CA.

Секретные DKG shares передаются непосредственно получателю, не через
coordinator. Запись БД выполняется через temporary file + atomic rename;
POSIX mode — `0600`. In-flight signing nonce/state никогда не сохраняется:
после crash церемония должна начаться заново.

## Ограничения перед production

Это полноценная криптографическая реализация, но не утверждение о завершённом
аудите всей системы. До хранения реальной стоимости необходимы независимый
аудит конкретного commit, protocol transcript fuzzing, mTLS/HSM или enclave для
долей, rollback-resistant storage, rate limits, мониторинг, runbooks для backup
и disaster recovery. Telegram следует считать approval UI, а не единственным
фактором аутентификации для крупного custody.
